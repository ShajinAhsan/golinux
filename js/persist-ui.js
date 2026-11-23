/* Persistence status display and safe Reset button (lock + unload disarm). */

import { setPersistStatus } from "./status.js";

export function setupPersistUI() {
  if (!window.GoPersist) return;

  window.GoPersist.setStatusHandler((msg, kind) => {
    setPersistStatus(msg, kind);
  });

  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    resetBtn.onclick = async () => {
      const ok = window.confirm(
        "Reset to a fresh machine?\n\n" +
        "This permanently deletes your saved files and session on this device. " +
        "The page will reload with a clean Debian install."
      );
      if (!ok) return;

      resetBtn.disabled = true;
      window.GoPersist.prepareReset();
      await window.GoPersist.clearUserState();
      location.reload();
    };
  }
}
