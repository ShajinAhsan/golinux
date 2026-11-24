/* Status chrome, overlays, progress bar, offline banner, and non-shifting disk toast.
 * NEVER touches guest stdin. */

const $ = (id) => document.getElementById(id);

export function mb(n) {
  return (n / 1048576).toFixed(1);
}

export function fmtBytes(bytes) {
  if (!bytes) return "";
  if (bytes >= 1048576) return mb(bytes) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function fmtSpeed(bps) {
  if (!(bps > 0) || !Number.isFinite(bps)) return "";
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
  return Math.max(1, Math.round(bps / 1024)) + " KB/s";
}

export function fmtEta(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `~${m}m ${rem}s left` : `~${m}m left`;
}

export function setStatus(text) {
  const el = $("status");
  if (el) el.textContent = text;
  const dot = $("statusDot");
  if (dot) {
    const t = String(text || "").toLowerCase();
    dot.classList.toggle("ok", t === "running");
    dot.classList.toggle("err", t === "cannot start" || t === "outdated" || t === "stopped" || t.includes("failed"));
  }
}

export function setPersistStatus(msg, kind) {
  const el = $("persistStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.title = msg || "";
  el.className = kind || "";
}

export function setLoading(title, detail) {
  const el = $("loading");
  if (!el) return;
  $("loadingTitle").textContent = title || "";
  $("loadingDetail").textContent = detail || "";
  el.classList.add("visible");
}

export function clearLoading() {
  const el = $("loading");
  if (el) el.classList.remove("visible");
}

export function showFatal(title, detail) {
  const el = $("fatal");
  if (!el) return;
  el.querySelector(".fatal-title").textContent = title;
  el.querySelector(".fatal-detail").textContent = detail;
  el.classList.add("visible");
  setStatus("cannot start");
  clearLoading();
}

export function showProgress(loaded, total, bps) {
  const el = $("progress");
  if (!el) return;
  el.classList.add("visible");
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
  $("progressFill").style.width = pct.toFixed(1) + "%";
  const parts = [total ? `${mb(loaded)}/${mb(total)} MB` : `${mb(loaded)} MB`];
  if (bps > 0) {
    parts.push(fmtSpeed(bps));
    if (total > loaded) parts.push(fmtEta((total - loaded) / bps));
  }
  $("progressPct").textContent = parts.join(" · ");
}

export function hideProgress() {
  const el = $("progress");
  if (el) el.classList.remove("visible");
}

let bannerDismissed = false;

export function showOfflineBanner() {
  if (bannerDismissed) return;
  const el = $("offlineBanner");
  if (el) el.classList.add("visible");
}

export function hideOfflineBanner() {
  bannerDismissed = false;
  const el = $("offlineBanner");
  if (el) el.classList.remove("visible");
}

let updateDismissed = false;

export function showUpdateBanner() {
  if (updateDismissed) return;
  const el = $("updateBanner");
  if (el) {
    el.hidden = false;
    el.classList.add("visible");
  }
}

export function setupStatusChrome() {
  const reloadBtn = $("fatalReload");
  if (reloadBtn) reloadBtn.onclick = () => location.reload();

  const updateReload = $("updateBannerReload");
  if (updateReload) {
    updateReload.onclick = () => {
      try { sessionStorage.removeItem("gl_reloaded_for"); } catch (e) {}
      location.reload();
    };
  }

  const updateDismiss = $("updateBannerDismiss");
  if (updateDismiss) {
    updateDismiss.onclick = () => {
      updateDismissed = true;
      const el = $("updateBanner");
      if (el) {
        el.hidden = true;
        el.classList.remove("visible");
      }
    };
  }

  const dismissBtn = $("offlineBannerDismiss");
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      bannerDismissed = true;
      $("offlineBanner").classList.remove("visible");
    };
  }

  const openPacks = $("offlineBannerOpen");
  if (openPacks) {
    openPacks.onclick = () => {
      const btn = $("openPacks");
      if (btn) btn.click();
    };
  }
}

/* ---------- Floating disk-loading toast (zero layout shift!) ---------- */

const DISK_SHOW_FAST_MS = 450;
const DISK_SHOW_SLOW_MS = 250;
const DISK_HIDE_MS = 320;
const BURST_SPEED_WINDOW_MS = 2500;
let diskShowTimer = null;
let diskHideTimer = null;
let diskVisible = false;
let burstStart = 0;
let burstBaseBytes = 0;
let burstSamples = [];
let lastDiskFiles = 0;
let lastObservedBps = null;
let lastObservedMode = "fast";
let diskStats = { files: 0, bytes: 0, inflightBytes: 0, burstBytes: 0, liveBps: null, bps: null, mode: "fast" };
let customLabelFn = null;

function computeBurstBps(now) {
  const cutoff = now - BURST_SPEED_WINDOW_MS;
  while (burstSamples.length > 2 && burstSamples[0].t < cutoff) burstSamples.shift();
  if (burstSamples.length >= 2) {
    const first = burstSamples[0];
    const last = burstSamples[burstSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const db = last.bytes - first.bytes;
    if (dt >= 0.45 && db >= 4096) return db / dt;
  }
  if (burstStart && diskStats.burstBytes >= 4096) {
    const dt = (now - burstStart) / 1000;
    if (dt >= 0.6) return diskStats.burstBytes / dt;
  }
  return null;
}

export function setDiskLabelProvider(fn) {
  customLabelFn = fn;
}

export function getLastNetworkInfo() {
  return { bps: lastObservedBps, mode: lastObservedMode };
}

export function noteObservedNetwork(bps, mode) {
  if (bps > 0 && Number.isFinite(bps)) lastObservedBps = bps;
  if (mode === "slow" || mode === "fast") lastObservedMode = mode;
}

function renderDiskToast() {
  const labelEl = $("diskLabel");
  const subEl = $("diskSub");
  const fillEl = $("diskFill");
  const metaEl = $("diskMeta");
  if (!labelEl || !subEl) return;

  const now = Date.now();
  const elapsedMs = burstStart ? (now - burstStart) : 0;
  // Use ONLY live speed measured during THIS active burst — never a stale
  // historical / HTTP-cache reading from earlier in the session.
  const liveBps = diskStats.liveBps || computeBurstBps(now);
  if (liveBps > 0 && elapsedMs >= 600) {
    lastObservedBps = liveBps;
  }
  const custom = customLabelFn && customLabelFn({
    burstBytes: diskStats.burstBytes,
    inflightBytes: diskStats.inflightBytes,
    bps: liveBps,
    mode: diskStats.mode,
    elapsedMs,
  });

  if (custom) {
    labelEl.textContent = custom.label;
    subEl.textContent = custom.sub || "";
    if (fillEl) {
      if (typeof custom.pct === "number" && Number.isFinite(custom.pct)) {
        fillEl.classList.remove("indeterminate");
        fillEl.style.width = Math.max(4, Math.min(100, custom.pct)).toFixed(1) + "%";
      } else {
        fillEl.classList.add("indeterminate");
        fillEl.style.width = "";
      }
    }
    if (metaEl) {
      metaEl.textContent = custom.meta || "";
      metaEl.hidden = !custom.meta;
    }
    return;
  }

  labelEl.textContent = "Loading from disk…";
  subEl.textContent = diskStats.burstBytes > 0
    ? fmtBytes(diskStats.burstBytes)
    : "fetching…";
  if (fillEl) {
    fillEl.classList.add("indeterminate");
    fillEl.style.width = "";
  }
  if (metaEl) {
    if (elapsedMs >= 1200) {
      const bits = [];
      if (liveBps) bits.push(fmtSpeed(liveBps));
      if (diskStats.mode === "slow") bits.push("low-bandwidth mode");
      bits.push("cached after first run");
      metaEl.textContent = bits.join(" · ");
      metaEl.hidden = false;
    } else {
      metaEl.textContent = "";
      metaEl.hidden = true;
    }
  }
}

function showDiskToast() {
  clearTimeout(diskHideTimer);
  diskHideTimer = null;
  if (diskVisible) return;
  diskVisible = true;
  renderDiskToast();
  const toast = $("diskToast");
  if (toast) toast.classList.add("visible");
}

function hideDiskToast(onHide) {
  clearTimeout(diskShowTimer);
  diskShowTimer = null;
  if (!diskVisible) return;
  diskVisible = false;
  const toast = $("diskToast");
  if (toast) toast.classList.remove("visible");
  diskStats = { files: 0, bytes: 0, inflightBytes: 0, burstBytes: 0, bps: lastObservedBps, mode: lastObservedMode };
  if (onHide) onHide();
}

export function handleDiskActivity(msg, { enabled = true, onNames, onBurstEnd } = {}) {
  const now = Date.now();
  const newFiles = (msg.files || 0) - lastDiskFiles;
  lastDiskFiles = msg.files || 0;
  const busy = !msg.idle && ((msg.pending || 0) > 0 || newFiles > 0);

  if (msg.bps > 0) lastObservedBps = msg.bps;
  if (msg.mode === "slow" || msg.mode === "fast") lastObservedMode = msg.mode;

  if (window.GoPersist && window.GoPersist.setDiskBusy) {
    window.GoPersist.setDiskBusy((msg.pending || 0) > 0);
  }
  if (!enabled) return;

  const showDelay = lastObservedMode === "slow" ? DISK_SHOW_SLOW_MS : DISK_SHOW_FAST_MS;

  if (busy && !burstStart) {
    burstStart = now;
    burstBaseBytes = Math.max(0, msg.bytes || 0);
    burstSamples = [{ t: now, bytes: 0 }];
  }

  if (busy) {
    clearTimeout(diskHideTimer);
    diskHideTimer = null;
    const completedDelta = Math.max(0, (msg.bytes || 0) - burstBaseBytes);
    const burstBytes = completedDelta + (msg.inflightBytes || 0);
    if (!burstSamples.length || burstBytes > burstSamples[burstSamples.length - 1].bytes) {
      burstSamples.push({ t: now, bytes: burstBytes });
      if (burstSamples.length > 64) burstSamples.splice(0, burstSamples.length - 64);
    }
    diskStats = {
      files: msg.files || 0,
      bytes: msg.bytes || 0,
      inflightBytes: msg.inflightBytes || 0,
      burstBytes,
      liveBps: (msg.liveBps > 0 && Number.isFinite(msg.liveBps)) ? msg.liveBps : null,
      bps: msg.bps || lastObservedBps,
      mode: msg.mode || lastObservedMode,
    };
    const completedNames = Array.isArray(msg.names) ? msg.names : [];
    const activeNames = Array.isArray(msg.activeNames) ? msg.activeNames : [];
    if (onNames && (completedNames.length || activeNames.length)) {
      onNames(completedNames, activeNames, diskVisible);
    }
    const elapsed = burstStart ? now - burstStart : 0;
    if (diskVisible) {
      renderDiskToast();
    } else if (elapsed >= showDelay) {
      clearTimeout(diskShowTimer);
      diskShowTimer = null;
      showDiskToast();
    } else if (!diskShowTimer) {
      diskShowTimer = setTimeout(() => {
        diskShowTimer = null;
        if (!burstStart) return;
        if (Date.now() - burstStart >= showDelay && !diskVisible) {
          showDiskToast();
        }
      }, showDelay - elapsed);
    }
  } else {
    clearTimeout(diskShowTimer);
    diskShowTimer = null;
    const lasted = burstStart ? now - burstStart : 0;
    burstStart = 0;
    burstBaseBytes = msg.bytes || 0;
    burstSamples = [];
    if (diskVisible && !diskHideTimer) {
      diskHideTimer = setTimeout(() => hideDiskToast(onBurstEnd), DISK_HIDE_MS);
    } else if (!diskVisible && lasted < showDelay && onBurstEnd) {
      onBurstEnd();
    }
  }
}
