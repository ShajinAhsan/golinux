/* Tools & Offline Cache modal UI (active when GL_FEATURES.packs === true).
 *
 * Shows:
 *   - Live measured connection speed + Auto / Low-BW / Fast mode switcher
 *   - Background idle auto-warm toggle + live warming status
 *   - Per-tool cache readiness grid with realistic ETAs and one-click Preload
 *   - Bundle-native offline packs (Minimal, Common tools, Full disk)
 */

import { fmtBytes, fmtEta, fmtSpeed, getLastNetworkInfo } from "./status.js";
import { cachedChunkNameSet, INSTANT_TOOLS, loadToolSets } from "./tool-progress.js";
import { getWarmState, isAutoWarmEnabled, setAutoWarmEnabled, suspendWarmingForSession } from "./prefetch.js";

const BW_PREF_KEY = "golinux.bwMode";

function networkSaysFrugal() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return /^(slow-2g|2g|3g)$/.test(c.effectiveType || "");
}

function getSavedBwPref() {
  try {
    const v = localStorage.getItem(BW_PREF_KEY);
    if (v === "auto" || v === "slow" || v === "fast") return v;
  } catch (_) {}
  return "auto";
}

function saveBwPref(mode) {
  try { localStorage.setItem(BW_PREF_KEY, mode); } catch (_) {}
  if ("serviceWorker" in navigator && navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "set-bandwidth-mode", mode });
  }
}

function requestBwStatus() {
  if ("serviceWorker" in navigator && navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "get-bandwidth-status" });
  }
}

function packLabel(id, st, allStates) {
  if (!st) return "…";
  if (id === "common" && allStates && allStates.full && allStates.full.complete) {
    return "included in Full";
  }
  if (st.total && st.complete) return "saved";
  if (st.present > 0) return `${st.present} of ${st.total} saved (resume)`;
  return "not saved";
}

function packSizes(states, manifest) {
  let bytes = 0;
  for (const id of ["common", "full"]) {
    const st = states[id];
    const info = manifest[id];
    if (st && st.total && info) bytes = Math.max(bytes, info.bytes * (st.present / st.total));
  }
  return bytes;
}

export function setupPacksUI({ trapModalFocus } = {}) {
  if (!GL_FEATURES.packs || !window.GoPacks) {
    return { refreshBandwidth() {}, refreshWarmState() {} };
  }

  const packsEl = document.getElementById("packs");
  const packStatusEl = document.getElementById("packStatus");
  const packProgressEl = document.getElementById("packProgress");
  const packProgressFill = document.getElementById("packProgressFill");
  const packProgressPct = document.getElementById("packProgressPct");
  const packProgressLabel = document.getElementById("packProgressLabel");
  const packPauseBtn = document.getElementById("packPause");
  const packCancelBtn = document.getElementById("packCancel");
  const openBtn = document.getElementById("openPacks");
  const closeBtn = document.getElementById("closePacks");
  const clearAllBtn = document.getElementById("clearAllCache");
  const bwBadgeEl = document.getElementById("bwSpeedBadge");
  const bwSegButtons = Array.from(document.querySelectorAll(".bw-seg button[data-bw]"));
  const autoWarmToggle = document.getElementById("autoWarmToggle");
  const autoWarmStateEl = document.getElementById("autoWarmState");
  const toolsGridEl = document.getElementById("toolsGrid");
  const toolsReadyCountEl = document.getElementById("toolsReadyCount");

  let packManifest = {};
  let currentBwPref = getSavedBwPref();
  let wasBusy = false;
  let lastWarmTool = "";

  const isModalVisible = () => !!(packsEl && packsEl.classList.contains("visible"));

  function renderBandwidth(infoOverride) {
    if (!isModalVisible()) return;
    const info = infoOverride || getLastNetworkInfo();
    const bps = info && info.bps > 0 ? info.bps : null;
    const mode = (info && (info.mode === "slow" || info.mode === "fast"))
      ? info.mode
      : (currentBwPref === "slow" ? "slow" : (networkSaysFrugal() ? "slow" : "fast"));

    if (bwBadgeEl) {
      const speed = bps ? fmtSpeed(bps) : "";
      const modeLbl = mode === "slow" ? "Low-BW (Range)" : "Fast (Bundles)";
      bwBadgeEl.textContent = speed ? `${speed} · ${modeLbl}` : modeLbl;
      bwBadgeEl.classList.toggle("slow", mode === "slow");
    }
    for (const btn of bwSegButtons) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-bw") === currentBwPref));
    }
    const frugalEl = document.getElementById("saveDataNote");
    if (frugalEl) frugalEl.classList.toggle("visible", mode === "slow" || networkSaysFrugal());
  }

  function renderWarmState(state) {
    const st = state || getWarmState();
    if (!isModalVisible()) {
      lastWarmTool = st.tool || "";
      return;
    }
    if (autoWarmToggle) autoWarmToggle.checked = !!st.enabled;
    if (autoWarmStateEl) {
      autoWarmStateEl.textContent = st.status ? `(${st.status})` : "";
    }
    // Only re-scan & redraw the tool grid when a whole tool finishes warming
    // (tool title changed) or warming completes — never on every single chunk!
    const toolChanged = (st.tool || "") !== lastWarmTool;
    lastWarmTool = st.tool || "";
    if (toolChanged || st.status === "all warmed" || st.status === "core tools warmed") {
      renderToolsGrid();
    }
  }

  async function renderToolsGrid() {
    if (!toolsGridEl) return;
    const sets = await loadToolSets();
    const have = await cachedChunkNameSet();
    const info = getLastNetworkInfo();
    const bps = info && info.bps > 0 ? info.bps : null;
    const running = window.GoPacks.getJob ? window.GoPacks.getJob() : null;
    const busy = !!running;

    const rows = [];
    for (const t of INSTANT_TOOLS) {
      rows.push({ id: t.id, title: t.title, ready: true, remBytes: 0, list: [] });
    }
    if (sets) {
      const ids = Object.keys(sets).sort((a, b) => (sets[a].bytes || 0) - (sets[b].bytes || 0));
      for (const id of ids) {
        const s = sets[id];
        let missing = 0;
        for (const ch of s.list) if (!have.has(ch)) missing++;
        const fracMissing = s.list.length ? (missing / s.list.length) : 0;
        const remBytes = Math.round((s.bytes || 0) * fracMissing);
        rows.push({
          id,
          title: s.title || id,
          ready: missing === 0,
          remBytes,
          list: s.list,
        });
      }
    }

    const readyCount = rows.filter((r) => r.ready).length;
    if (toolsReadyCountEl) {
      toolsReadyCountEl.textContent = `${readyCount}/${rows.length} ready`;
    }

    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const chip = document.createElement("div");
      chip.className = "tool-chip" + (r.ready ? " ready" : "");

      const meta = document.createElement("div");
      meta.className = "tc-meta";

      const nameEl = document.createElement("span");
      nameEl.className = "tc-name";
      nameEl.textContent = r.title;

      const subEl = document.createElement("span");
      subEl.className = "tc-sub";
      if (r.ready) {
        subEl.textContent = "Ready · instant";
      } else {
        const sz = fmtBytes(r.remBytes) || "…";
        const eta = bps && r.remBytes > 0 ? fmtEta(r.remBytes / bps).replace(" left", "") : "";
        subEl.textContent = eta ? `${sz} · ${eta}` : sz;
      }

      meta.append(nameEl, subEl);
      chip.appendChild(meta);

      if (!r.ready) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-preload-tool", r.id);
        btn.disabled = busy;
        btn.textContent = (running && running.kind === "tool" && running.packId === r.id) ? "…" : "Preload";
        chip.appendChild(btn);
      }

      frag.appendChild(chip);
    }

    toolsGridEl.textContent = "";
    toolsGridEl.appendChild(frag);
  }

  let lastQuotaAt = 0;

  async function showQuota(force) {
    const el = document.getElementById("packQuota");
    if (!el) return;
    const now = Date.now();
    if (!force && now - lastQuotaAt < 1500) return;
    lastQuotaAt = now;
    try {
      const actual = window.GoPacks.estimateActualCacheBytes
        ? await window.GoPacks.estimateActualCacheBytes()
        : null;
      const est = (navigator.storage && navigator.storage.estimate)
        ? await navigator.storage.estimate()
        : null;

      if (actual && actual.totalBytes > 0) {
        const realStr = fmtBytes(actual.totalBytes);
        // Safari/WebKit reports padded or lazily-reclaimed storage in estimate().usage
        // even after cache deletion; show our real cached size clearly.
        if (est && est.usage > actual.totalBytes * 2.2 && est.usage > 50 * 1048576) {
          el.textContent = `${realStr} cached (browser reclaiming ${fmtBytes(est.usage)})`;
          el.title = `Actual GoLinux disk cache: ${realStr}. Browser reported ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} (Safari/WebKit reclaims deleted cache space lazily).`;
        } else if (est && est.quota) {
          el.textContent = `${realStr} cached · ${fmtBytes(est.quota)} free quota`;
          el.title = `Browser origin usage: ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}`;
        } else {
          el.textContent = `${realStr} cached`;
        }
        return;
      }
      if (est) {
        el.textContent = `using ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} available`;
      }
    } catch (e) {
      el.textContent = "";
    }
  }

  function renderPacks(states) {
    states = states || {};
    const running = window.GoPacks.getJob ? window.GoPacks.getJob() : null;
    const busy = !!running;
    const info = getLastNetworkInfo();
    const bps = info && info.bps > 0 ? info.bps : null;

    for (const id of ["minimal", "common", "full"]) {
      const sizeEl = document.querySelector(`[data-size="${id}"]`);
      const badgeEl = document.querySelector(`[data-badge="${id}"]`);
      const row = document.querySelector(`.pack[data-pack="${id}"]`);
      const infoPack = packManifest[id];
      const st = states[id];

      if (sizeEl && infoPack) {
        if (id === "minimal") {
          sizeEl.textContent = fmtBytes(infoPack.totalBytes);
        } else {
          const eta = bps && !(st && st.complete) && infoPack.bytes
            ? " · " + fmtEta(infoPack.bytes / bps).replace(" left", "")
            : "";
          sizeEl.textContent = `${fmtBytes(infoPack.bytes)}${eta}`;
        }
      }
      if (badgeEl) {
        badgeEl.textContent = id === "minimal" ? "" : "· " + packLabel(id, st, states);
      }
      if (row) row.classList.toggle("installed", !!(st && st.complete));

      const isRunningPack = busy && running.packId === id;
      const saveBtn = document.querySelector(`[data-install="${id}"]`);
      const remBtn = document.querySelector(`[data-remove="${id}"]`);

      if (saveBtn) {
        if (id === "minimal") {
          saveBtn.disabled = busy && !isRunningPack;
          saveBtn.textContent = "Use";
        } else {
          const alreadyDone = !!(st && st.complete);
          saveBtn.disabled = busy || alreadyDone;
          saveBtn.textContent = alreadyDone ? "Saved" : (st && st.present > 0 ? "Resume" : "Save");
        }
      }
      if (remBtn) {
        const coveredByFull = id === "common" && states.full && states.full.complete;
        remBtn.disabled = (busy && !isRunningPack) || coveredByFull;
        remBtn.textContent = (isRunningPack && running.kind === "download") ? "Cancel" : "Remove";
      }
    }

    renderBandwidth();
    showQuota(!busy);
  }

  function renderPackProgress(s) {
    const j = s && s.job;
    if (!j) {
      packProgressEl.classList.remove("visible");
      return;
    }
    packProgressEl.classList.add("visible");
    const pct = j.total ? (j.done / j.total) * 100 : 0;
    packProgressFill.style.width = pct.toFixed(1) + "%";
    const isDownloadLike = j.kind === "download" || j.kind === "tool";
    const verb = j.paused
      ? "Paused"
      : (j.kind === "tool" ? "Preloading" : (j.kind === "download" ? "Downloading" : "Removing"));
    const noun = j.kind === "tool" ? j.packId : `${j.packId} pack`;
    packProgressLabel.textContent = `${verb} ${noun}`;
    packProgressPct.textContent = `${j.done}/${j.total} · ${fmtBytes(j.loaded) || "0 KB"}`;
    packPauseBtn.textContent = j.paused ? "Resume" : "Pause";
    packPauseBtn.disabled = !isDownloadLike;
  }

  window.GoPacks.onUpdate((s) => {
    renderPackProgress(s);
    const nowBusy = !!(s && s.job);
    const transition = nowBusy !== wasBusy;
    wasBusy = nowBusy;
    // During an active download, only update the lightweight progress bar;
    // rebuild pack rows & tool chips only on job start/end or when idle.
    if (transition || !nowBusy) {
      if (isModalVisible()) {
        renderPacks(s.states);
        renderToolsGrid();
      }
    }
  });

  if (autoWarmToggle) {
    autoWarmToggle.checked = isAutoWarmEnabled();
    autoWarmToggle.addEventListener("change", () => {
      setAutoWarmEnabled(autoWarmToggle.checked);
    });
  }

  for (const btn of bwSegButtons) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-bw");
      if (!mode) return;
      currentBwPref = mode;
      saveBwPref(mode);
      renderBandwidth({
        bps: getLastNetworkInfo().bps,
        mode: mode === "auto" ? getLastNetworkInfo().mode : mode,
      });
    });
  }

  let releaseFocus = null;
  const closePacksModal = () => {
    packsEl.classList.remove("visible");
    if (releaseFocus) { releaseFocus(); releaseFocus = null; }
  };

  if (openBtn) {
    openBtn.onclick = async () => {
      packsEl.classList.add("visible");
      if (typeof trapModalFocus === "function") releaseFocus = trapModalFocus(packsEl);
      requestBwStatus();
      renderBandwidth();
      renderWarmState();
      packManifest = await window.GoPacks.loadManifest();
      renderPacks(await window.GoPacks.packStates());
      showQuota(true);
      await renderToolsGrid();
    };
  }
  if (clearAllBtn) {
    clearAllBtn.onclick = async () => {
      if (!window.confirm("Clear all cached packs and preloaded tools? Your saved files in /root and boot snapshot stay intact.")) return;
      packStatusEl.textContent = "";
      suspendWarmingForSession();
      const res = await window.GoPacks.clearToolCaches();
      if (res && res.refused) packStatusEl.textContent = res.reason;
      else if (res && res.error) packStatusEl.textContent = "Failed: " + res.error;
      else packStatusEl.textContent = `Cleared ${res && res.deleted ? res.deleted : 0} cached chunks.`;
      renderPacks(await window.GoPacks.packStates());
      renderWarmState();
      showQuota(true);
      await renderToolsGrid();
    };
  }
  if (closeBtn) closeBtn.onclick = closePacksModal;
  packsEl.addEventListener("click", (e) => {
    if (e.target === packsEl) closePacksModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isModalVisible()) closePacksModal();
  });

  packsEl.addEventListener("click", async (e) => {
    const t = e.target.closest && e.target.closest("button");
    if (!t || t.disabled) return;

    const preloadToolId = t.getAttribute("data-preload-tool");
    if (preloadToolId) {
      packStatusEl.textContent = "";
      const sets = await loadToolSets();
      const tool = sets && sets[preloadToolId];
      if (!tool || !tool.list || !tool.list.length) {
        packStatusEl.textContent = "Tool manifest unavailable offline.";
        return;
      }
      const res = await window.GoPacks.installTool(preloadToolId, tool.list);
      if (res && res.refused) packStatusEl.textContent = res.reason;
      else if (res && res.error) packStatusEl.textContent = "Failed: " + res.error;
      else if (res && res.cancelled) packStatusEl.textContent = res.reason;
      else if (res && res.complete) packStatusEl.textContent = `${tool.title} is now cached and ready.`;
      await renderToolsGrid();
      return;
    }

    const installId = t.getAttribute("data-install");
    const removeId = t.getAttribute("data-remove");
    if (!installId && !removeId) return;

    packStatusEl.textContent = "";
    let result;
    const wasMinimal = installId === "minimal";

    if (wasMinimal) {
      const states = await window.GoPacks.packStates();
      const anySaved = (states.common && states.common.present > 0) ||
                       (states.full && states.full.present > 0);
      if (!anySaved && !window.GoPacks.getJob()) {
        packStatusEl.textContent = "Minimal is already in use.";
        return;
      }
      const size = fmtBytes(packSizes(states, packManifest));
      if (!window.confirm("This removes the saved packs" + (size ? " (" + size + ")" : "") + ". Continue?")) {
        packStatusEl.textContent = "Cancelled.";
        return;
      }
      result = await window.GoPacks.useMinimal();
    } else if (installId) {
      result = await window.GoPacks.install(installId);
    } else {
      result = await window.GoPacks.removePack(removeId);
    }

    if (result && result.refused) packStatusEl.textContent = result.reason;
    else if (result && result.error) packStatusEl.textContent = "Failed: " + result.error;
    else if (result && result.cancelled) packStatusEl.textContent = result.reason;
    else if (result && result.incomplete) packStatusEl.textContent = result.reason;
    else if (result && result.complete) packStatusEl.textContent = "Saved " + installId + " pack.";
    else if (result && typeof result.deleted === "number") {
      packStatusEl.textContent = wasMinimal
        ? `Removed all saved pack chunks (${result.deleted} chunks).`
        : `Removed ${removeId} pack (${result.deleted} chunks; shared chunks kept).`;
    }
    renderPacks(await window.GoPacks.packStates());
    await renderToolsGrid();
  });

  if (packPauseBtn) {
    packPauseBtn.onclick = () => {
      const j = window.GoPacks.getJob();
      if (!j) return;
      if (j.paused) window.GoPacks.resume();
      else window.GoPacks.pause();
    };
  }
  if (packCancelBtn) {
    packCancelBtn.onclick = () => {
      if (!window.GoPacks.cancel()) packStatusEl.textContent = "Nothing to cancel.";
    };
  }

  return {
    refreshBandwidth: renderBandwidth,
    refreshWarmState: renderWarmState,
  };
}
