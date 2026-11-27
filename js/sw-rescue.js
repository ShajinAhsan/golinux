/* Service Worker early-upgrade rescue handler (externalized for strict CSP). */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (window.__glUpgradeHandled) return;
    window.__glUpgradeHandled = true;
    var k = "golinux.sw_rescue_" + (window.GL_VERSION || "old");
    if (!window.__glBootStarted) {
      try {
        if (sessionStorage.getItem(k) !== "1") {
          sessionStorage.setItem(k, "1");
          location.reload();
          return;
        }
      } catch (e) {}
    }
    var b = document.getElementById("updateBanner");
    if (b) {
      b.hidden = false;
      b.classList.add("visible");
    }
  });
})();
