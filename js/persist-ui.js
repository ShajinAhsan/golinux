/* Persistence status display and safe Reset button (lock + unload disarm). */

import { setPersistStatus } from "./status.js";

export function setupPersistUI() {
  if (!window.GoPersist) return;

  window.GoPersist.setStatusHandler((msg, kind) => {
    setPersistStatus(msg, kind);
  });

  const saveBtn = document.getElementById("saveBtn");
  const triggerManualSave = async () => {
    if (!window.emulator || !window.GoPersist) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await window.GoPersist.saveNow(window.emulator, "manual");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  };
  if (saveBtn) {
    saveBtn.onclick = triggerManualSave;
  }

  const persistEl = document.getElementById("persistStatus");
  if (persistEl) {
    persistEl.addEventListener("click", () => {
      if (window.GoPersist && window.GoPersist.isDirty && window.GoPersist.isDirty()) {
        triggerManualSave();
      }
    });
  }

  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    resetBtn.onclick = async () => {
      const ok = window.confirm(
        "Reset to a fresh machine?\n\n" +
        "This permanently deletes your saved files and session on this device " +
        "and refreshes cached app data. The page will reload with a clean Alpine Linux install."
      );
      if (!ok) return;

      resetBtn.disabled = true;
      window.GoPersist.prepareReset();
      await window.GoPersist.clearUserState();

      // When online, also clear cached app/snapshot data and unregister the
      // Service Worker so Reset always pulls the latest deployed version (even
      // if Safari or a normal tab had pinned an older SW cache).
      const online = navigator.onLine !== false && await fetch("images/build-id.json", { cache: "no-store" })
        .then((r) => r.ok)
        .catch(() => false);
      if (online) {
        try {
          if (typeof caches !== "undefined") {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k.startsWith("golinux-")).map((k) => caches.delete(k)));
          }
        } catch (e) {}
        try {
          if ("serviceWorker" in navigator && navigator.serviceWorker) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
        } catch (e) {}
      }

      try { sessionStorage.removeItem("golinux.reloaded_for"); } catch (e) {}
      location.reload();
    };
  }
}
