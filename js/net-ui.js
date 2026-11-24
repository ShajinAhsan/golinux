/* GoLinux opt-in zero-server network toggle UI & non-shifting toast hints.
 *
 * INV-1: NEVER writes to guest stdin. Toggles SafeFetchNetworkAdapter live on
 * the host side without restarting the VM.
 */

let getAdapter = () => null;
let desiredEnabled = false;
let toastTimer = null;
let hintedPort443 = false;

export function isNetDesiredEnabled() {
  return desiredEnabled;
}

export function showNetToast(message, kind = "info", durationMs = 5200) {
  const el = document.getElementById("netToast");
  const label = document.getElementById("netToastLabel");
  if (!el || !label) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  label.textContent = message;
  el.classList.remove("ok", "warn");
  if (kind === "ok") el.classList.add("ok");
  else if (kind === "warn") el.classList.add("warn");
  el.classList.add("visible");
  toastTimer = setTimeout(() => {
    el.classList.remove("visible");
    toastTimer = null;
  }, durationMs);
}

export function syncNetUI(enabled) {
  const on = !!enabled;
  const btn = document.getElementById("netBtn");
  if (btn) {
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("net-on", on);
    const lbl = btn.querySelector(".net-lbl");
    if (lbl) lbl.textContent = on ? "Net: On" : "Net: Off";
    btn.title = on
      ? "Zero-server Fetch internet is ON (CORS APIs + DoH). Click to go offline."
      : "Offline sandbox (default). Click to enable zero-server browser Fetch internet.";
  }

  const mBtn = document.getElementById("mNet");
  if (mBtn) {
    mBtn.textContent = on ? "Internet (Fetch): On" : "Internet (Fetch): Off";
  }
}

export function handleBlockedPortHint(port) {
  if (port === 443 && !hintedPort443) {
    hintedPort443 = true;
    showNetToast(
      "Zero-server mode: use http:// with curl (auto-upgraded to HTTPS by browser).",
      "warn",
      6500
    );
  }
}

export function setNetAdapterGetter(fn) {
  getAdapter = typeof fn === "function" ? fn : () => null;
}

export function setupNetUI() {
  if (!GL_FEATURES.network) return;

  const btn = document.getElementById("netBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = !desiredEnabled;
      if (next && navigator.onLine === false) {
        showNetToast("Browser is offline — connect to the internet first.", "warn", 4000);
        return;
      }
      desiredEnabled = next;
      const adapter = getAdapter();
      if (adapter) {
        adapter.setEnabled(desiredEnabled);
      }
      syncNetUI(desiredEnabled);
      if (desiredEnabled) {
        showNetToast("Browser Fetch ON — try: curl http://api.github.com/zen", "ok", 5200);
      } else {
        showNetToast("Network OFF — local offline sandbox restored.", "info", 3200);
      }
    });
  }

  // If browser goes offline while enabled, inform clearly (keep adapter safe).
  window.addEventListener("offline", () => {
    if (desiredEnabled) {
      showNetToast("Browser went offline — Fetch requests will fail until reconnected.", "warn", 4500);
    }
  });

  syncNetUI(desiredEnabled);
}
