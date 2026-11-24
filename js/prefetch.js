/* Polite, yield-immediately background tool pre-warmer.
 *
 * Uses idle time (after boot and >= 3 s of disk silence) to quietly warm
 * everyday tools in smallest-first order. Any foreground disk read immediately
 * aborts the in-flight background chunk so user commands always get 100% of
 * slow 500 Kbps - 1 Mbps links. Respects navigator.connection.saveData and
 * user toggle in localStorage["golinux.autowarm"].
 */

import { cachedChunkNameSet, loadToolSets } from "./tool-progress.js";
import { getLastNetworkInfo } from "./status.js";

const PREF_KEY = "golinux.autowarm";
const IDLE_DELAY_MS = 3000;
const STEP_TIMEOUT_MS = 20000;

/** Priority order: smallest / most-used everyday tools first (~4.5 MB total).
 * Heavy optional runtimes (python3, curl) stay on-demand or one-click Preload
 * in the Tools modal so we never waste mobile/slow-link data unasked. */
export const WARM_PRIORITY = Object.freeze([
  "tcc", "gcc", "tree", "figlet", "make", "bc", "zip",
  "htop", "file", "nano", "jq", "tmux", "ls", "man", "git",
]);

let enabled = true;
let started = false;
let busyForeground = false;
let idleTimer = null;
let runningStep = false;
let pendingResolve = null;
let warmedBytes = 0;
let currentToolTitle = "";
let statusText = "idle";
let onChange = () => {};

function browserSaysSaveData() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return !!(c && c.saveData);
}

export function isAutoWarmEnabled() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch (_) {}
  return !browserSaysSaveData();
}

export function setAutoWarmEnabled(val) {
  enabled = !!val;
  try { localStorage.setItem(PREF_KEY, enabled ? "on" : "off"); } catch (_) {}
  if (!enabled) {
    abortWarm();
    statusText = "off";
    emit();
  } else {
    statusText = "waiting for idle";
    emit();
    scheduleNext(800);
  }
}

export function getWarmState() {
  return {
    enabled,
    status: statusText,
    tool: currentToolTitle,
    warmedBytes,
  };
}

function emit() {
  try { onChange(getWarmState()); } catch (_) {}
}

function abortWarm() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if ("serviceWorker" in navigator && navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "abort-idle-warm" });
  }
}

function currentBudgetBytes() {
  const info = getLastNetworkInfo();
  if (info.mode === "slow") {
    return typeof GL_PREFETCH_BUDGET_SLOW === "number" ? GL_PREFETCH_BUDGET_SLOW : (6 * 1024 * 1024);
  }
  return typeof GL_PREFETCH_BUDGET_FAST === "number" ? GL_PREFETCH_BUDGET_FAST : (16 * 1024 * 1024);
}

function canRunNow() {
  if (!GL_FEATURES.prefetch || !enabled || !started) return false;
  if (busyForeground) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (window.GoPacks && window.GoPacks.getJob && window.GoPacks.getJob()) return false;
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker || !navigator.serviceWorker.controller) return false;
  if (warmedBytes >= currentBudgetBytes()) return false;
  return true;
}

function scheduleNext(delayMs) {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!enabled || !started) return;
  if (warmedBytes >= currentBudgetBytes()) {
    statusText = "ready";
    currentToolTitle = "";
    emit();
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    runStep();
  }, delayMs);
}

async function pickNextChunk() {
  const sets = await loadToolSets();
  if (!sets) return null;
  const have = await cachedChunkNameSet();
  for (const id of WARM_PRIORITY) {
    const t = sets[id];
    if (!t || !Array.isArray(t.list)) continue;
    for (const ch of t.list) {
      if (!have.has(ch)) {
        return { tool: t.title || id, chunk: ch };
      }
    }
  }
  return null;
}

function sendWarmToSW(chunk) {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!ctrl) { resolve({ aborted: true }); return; }
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      if (pendingResolve === done) pendingResolve = null;
      clearTimeout(t);
      resolve(res || {});
    };
    pendingResolve = done;
    const t = setTimeout(() => done({ aborted: true }), STEP_TIMEOUT_MS);
    ctrl.postMessage({ type: "warm-chunks", priority: "idle", names: [chunk] });
  });
}

async function runStep() {
  if (runningStep || !canRunNow()) return;
  runningStep = true;
  try {
    const next = await pickNextChunk();
    if (!next) {
      currentToolTitle = "";
      statusText = "all warmed";
      emit();
      return;
    }
    if (!canRunNow()) return;
    currentToolTitle = next.tool;
    statusText = `warming ${next.tool}…`;
    emit();

    const res = await sendWarmToSW(next.chunk);
    if (res && res.bytes > 0) warmedBytes += res.bytes;
    if (res && res.aborted) {
      statusText = "yielded to command";
      emit();
      if (canRunNow()) scheduleNext(IDLE_DELAY_MS);
      return;
    }
    if (warmedBytes >= currentBudgetBytes()) {
      currentToolTitle = "";
      statusText = "core tools warmed";
      emit();
      return;
    }
    // Brief breather between chunks so the browser stays silky smooth.
    if (canRunNow()) scheduleNext(120);
  } finally {
    runningStep = false;
  }
}

export function handleIdleWarmResult(msg) {
  if (pendingResolve) pendingResolve(msg);
}

export function notifyDiskBusy(busy) {
  busyForeground = !!busy;
  if (busyForeground) {
    abortWarm();
    if (runningStep || statusText.startsWith("warming")) {
      statusText = "paused for command";
      emit();
    }
  } else if (enabled && started) {
    scheduleNext(IDLE_DELAY_MS);
  }
}

export function setupPrefetch(opts) {
  onChange = (opts && opts.onChange) || (() => {});
  enabled = isAutoWarmEnabled();
  statusText = enabled ? "waiting for idle" : "off";
  if (!GL_FEATURES.prefetch) return;

  window.addEventListener("gl-emulator-ready", () => {
    started = true;
    if (enabled) scheduleNext(IDLE_DELAY_MS);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) abortWarm();
    else if (enabled && started && !busyForeground) scheduleNext(IDLE_DELAY_MS);
  });

  window.addEventListener("offline", () => abortWarm());
  window.addEventListener("online", () => {
    if (enabled && started && !busyForeground) scheduleNext(IDLE_DELAY_MS);
  });
}
