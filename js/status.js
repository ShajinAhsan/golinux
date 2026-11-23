/* Status chrome, overlays, progress bar, offline banner, and non-shifting disk toast.
 * NEVER touches guest stdin. */

const $ = (id) => document.getElementById(id);

export function mb(n) {
  return (n / 1048576).toFixed(1);
}

export function fmtBytes(bytes) {
  if (!bytes) return "";
  if (bytes >= 1048576) return mb(bytes) + " MB";
  return Math.round(bytes / 1024) + " KB";
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

export function showProgress(loaded, total) {
  const el = $("progress");
  if (!el) return;
  el.classList.add("visible");
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
  $("progressFill").style.width = pct.toFixed(1) + "%";
  $("progressPct").textContent = total ? `${mb(loaded)}/${mb(total)} MB` : `${mb(loaded)} MB`;
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

const DISK_SHOW_MS = 500;
const DISK_HIDE_MS = 300;
let diskShowTimer = null;
let diskHideTimer = null;
let diskVisible = false;
let burstStart = 0;
let lastDiskFiles = 0;
let diskStats = { files: 0, bytes: 0 };
let customLabelFn = null;

export function setDiskLabelProvider(fn) {
  customLabelFn = fn;
}

function renderDiskToast() {
  const labelEl = $("diskLabel");
  const subEl = $("diskSub");
  if (!labelEl || !subEl) return;
  const custom = customLabelFn && customLabelFn();
  if (custom) {
    labelEl.textContent = custom.label;
    subEl.textContent = custom.sub;
    return;
  }
  labelEl.textContent = "Loading from disk…";
  subEl.textContent = `${diskStats.files} file${diskStats.files === 1 ? "" : "s"}, ${mb(diskStats.bytes)} MB`;
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
  diskStats = { files: 0, bytes: 0 };
  if (onHide) onHide();
}

export function handleDiskActivity(msg, { enabled = true, onNames, onBurstEnd } = {}) {
  const now = Date.now();
  const newFiles = (msg.files || 0) - lastDiskFiles;
  lastDiskFiles = msg.files || 0;
  const busy = !msg.idle && ((msg.pending || 0) > 0 || newFiles > 0);

  if (window.GoPersist && window.GoPersist.setDiskBusy) {
    window.GoPersist.setDiskBusy((msg.pending || 0) > 0);
  }
  if (!enabled) return;

  if (busy && !burstStart) burstStart = now;

  if (busy) {
    clearTimeout(diskHideTimer);
    diskHideTimer = null;
    diskStats = { files: msg.files || 0, bytes: msg.bytes || 0 };
    if (onNames && Array.isArray(msg.names) && msg.names.length) {
      onNames(msg.names, diskVisible);
    }
    const elapsed = burstStart ? now - burstStart : 0;
    if (diskVisible) {
      renderDiskToast();
    } else if (elapsed >= DISK_SHOW_MS) {
      clearTimeout(diskShowTimer);
      diskShowTimer = null;
      showDiskToast();
    } else if (!diskShowTimer) {
      diskShowTimer = setTimeout(() => {
        diskShowTimer = null;
        if (!burstStart) return;
        if (Date.now() - burstStart >= DISK_SHOW_MS && !diskVisible) {
          showDiskToast();
        }
      }, DISK_SHOW_MS - elapsed);
    }
  } else {
    clearTimeout(diskShowTimer);
    diskShowTimer = null;
    const lasted = burstStart ? now - burstStart : 0;
    burstStart = 0;
    if (diskVisible && !diskHideTimer) {
      diskHideTimer = setTimeout(() => hideDiskToast(onBurstEnd), DISK_HIDE_MS);
    } else if (!diskVisible && lasted < DISK_SHOW_MS && onBurstEnd) {
      onBurstEnd();
    }
  }
}
