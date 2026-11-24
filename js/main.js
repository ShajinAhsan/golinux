/* GoLinux main application entrypoint.
 *
 * Applies GL_FEATURES visibility, wires core modules in explicit startup order,
 * and handles service worker messages cleanly.
 */

import {
  clearLoading,
  handleDiskActivity,
  hideOfflineBanner,
  setStatus,
  setupStatusChrome,
  showFatal,
  showOfflineBanner,
  showUpdateBanner,
} from "./status.js";
import {
  bootMachine,
  currentNetAdapter,
  isBootStarted,
  prepareChunkAccess,
  restartMachine,
  triggerUpgradeReload,
} from "./boot.js";
import { observeTerminal } from "./terminal.js";
import { setupKeyBar } from "./keybar.js";
import { setupPersistUI } from "./persist-ui.js";
import { setupPacksUI } from "./packs-ui.js";
import { setupTransferUI } from "./transfer.js";
import { setupToolProgress } from "./tool-progress.js";
import { setNetAdapterGetter, setupNetUI } from "./net-ui.js";

function applyFeatureFlags() {
  for (const el of document.querySelectorAll("[data-feature]")) {
    const key = el.getAttribute("data-feature");
    if (!GL_FEATURES[key]) {
      el.hidden = true;
    }
  }
}

function setupBarMenu() {
  const menuBtn = document.getElementById("barMenuBtn");
  const menu = document.getElementById("barMenu");
  if (!menuBtn || !menu) return;

  const open = (v) => {
    menu.hidden = !v;
    menuBtn.setAttribute("aria-expanded", String(v));
  };

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    open(menu.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) open(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { open(false); menuBtn.focus(); }
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("button");
    if (!item) return;
    open(false);
    const target = {
      mNet: "netBtn",
      mPacks: "openPacks",
      mUpload: "uploadBtn",
      mDownload: "downloadBtn",
      mReset: "resetBtn",
    }[item.id];
    if (target) {
      const btn = document.getElementById(target);
      if (btn) btn.click();
    }
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 760 && !menu.hidden) open(false);
  });
}

function wireServiceWorkerMessages(toolHooks) {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return;

  navigator.serviceWorker.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || !data.type) return;

    if (data.type === "disk-activity") {
      // A real network chunk fetch succeeded, so connectivity is back.
      if (!data.idle && (data.bytes || 0) > 0) hideOfflineBanner();
      handleDiskActivity(data, {
        enabled: !!GL_FEATURES.diskIndicator,
        onNames: toolHooks.onNames,
        onBurstEnd: toolHooks.onBurstEnd,
      });
      return;
    }

    // Offline real-chunk miss: inform user cleanly via banner without claiming
    // "out of date" and without killing the VM (BUG-09).
    if (data.type === "chunk-offline" || data.type === "chunk-miss") {
      showOfflineBanner();
      return;
    }

    // Newly activated Service Worker from a fresh deploy.
    if (data.type === "sw-activated") {
      const versionChanged = data.version && data.version !== GL_VERSION;
      const buildChanged = data.buildId && GL_BUILD_ID && data.buildId !== GL_BUILD_ID;
      if (versionChanged || buildChanged) {
        if (!isBootStarted()) {
          triggerUpgradeReload("sw-act-" + (data.stamp || data.version));
        } else {
          showUpdateBanner();
        }
      }
      return;
    }

    // Real data chunk 404 (not offline): version mismatch or missing R2 object.
    if (data.type === "chunk-missing-real") {
      showFatal(
        "This version is out of date",
        "Disk data for this build could not be loaded (missing chunk " +
        (data.name || "") + "). Reload the page to load the current version."
      );
      setStatus("outdated");
      clearLoading();
      try { window.emulator && window.emulator.stop(); } catch (_) {}
    }
  });
}

function wireOfflineEvent() {
  window.addEventListener("offline", async () => {
    if (GL_FEATURES.packs && window.GoPacks) {
      try {
        const states = await window.GoPacks.packStates();
        if (!states.common.complete && !states.full.complete) showOfflineBanner();
        return;
      } catch (e) { /* fall through */ }
    }
    showOfflineBanner();
  });

  window.addEventListener("online", () => {
    hideOfflineBanner();
  });
}

// ---------- startup ----------
applyFeatureFlags();
setupStatusChrome();
setupBarMenu();
setupKeyBar();
observeTerminal();
setupPersistUI();
setupPacksUI();
setupTransferUI();
setNetAdapterGetter(currentNetAdapter);
setupNetUI();

const restartBtn = document.getElementById("restart");
if (restartBtn && GL_FEATURES.restartButton) {
  restartBtn.onclick = () => restartMachine();
}

const toolHooks = setupToolProgress();
wireServiceWorkerMessages(toolHooks);
wireOfflineEvent();

prepareChunkAccess().then((ok) => {
  if (!ok) return;
  bootMachine();
});
