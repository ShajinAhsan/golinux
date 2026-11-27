/* Terminal appearance settings (font size, pinch-to-zoom, themes, Zen mode,
 * scrollback search, and transcript export). Zero stdin injection (INV-1). */

import {
  currentTerminal,
  exportTranscript,
  getFontSizeOverride,
  getTerminalThemeId,
  scrollToBufferLine,
  searchScrollback,
  setFontSizeOverride,
  setOsc52Handler,
  setTerminalTheme,
  TERMINAL_THEMES,
} from "./terminal.js";
import { setPersistStatus } from "./status.js";

const PREFS_KEY = "golinux.prefs";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function savePrefs(patch) {
  try {
    const next = Object.assign(loadPrefs(), patch);
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch (_) {}
}

export function trapModalFocus(modalEl) {
  if (!modalEl) return () => {};
  const prev = document.activeElement;
  const focusables = () =>
    Array.from(modalEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);

  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  modalEl.addEventListener("keydown", onKey);
  requestAnimationFrame(() => {
    const list = focusables();
    if (list[0]) list[0].focus();
  });

  return () => {
    modalEl.removeEventListener("keydown", onKey);
    if (prev && typeof prev.focus === "function") {
      try { prev.focus(); } catch (_) {}
    }
  };
}

let zenMode = false;

export function setZenMode(on) {
  zenMode = !!on;
  document.body.classList.toggle("zen-mode", zenMode);
  const exitBtn = document.getElementById("zenExitBtn");
  if (exitBtn) exitBtn.hidden = !zenMode;
  const toggleBtn = document.getElementById("settingsZenBtn");
  if (toggleBtn) toggleBtn.setAttribute("aria-pressed", String(zenMode));
  savePrefs({ zenMode });
  window.dispatchEvent(new Event("resize"));
}

export function toggleZenMode() {
  setZenMode(!zenMode);
}

export function adjustFontSize(delta) {
  const cur = getFontSizeOverride() || (window.innerWidth <= 480 ? 12 : 14);
  const next = Math.max(10, Math.min(24, cur + delta));
  setFontSizeOverride(next);
  savePrefs({ fontSize: next });
  updateFontLabel();
}

export function resetFontSize() {
  setFontSizeOverride(null);
  savePrefs({ fontSize: null });
  updateFontLabel();
}

function updateFontLabel() {
  const el = document.getElementById("settingsFontLabel");
  if (!el) return;
  const val = getFontSizeOverride();
  el.textContent = val ? `${val}px` : "Auto";
}

export function downloadTranscriptFile() {
  const txt = exportTranscript();
  if (!txt) {
    setPersistStatus("Nothing in terminal scrollback yet.", "");
    return;
  }
  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `golinux-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setPersistStatus("Exported terminal transcript.", "ok");
}

let openSearchFn = null;
export function openScrollbackSearch() {
  if (openSearchFn) openSearchFn();
}

export function setupSettings() {
  const prefs = loadPrefs();
  if (typeof prefs.fontSize === "number") {
    setFontSizeOverride(prefs.fontSize);
  }
  if (prefs.theme && TERMINAL_THEMES[prefs.theme]) {
    setTerminalTheme(prefs.theme);
  }
  if (prefs.zenMode) {
    setZenMode(true);
  }

  setOsc52Handler((len) => {
    setPersistStatus(`Copied ${len} chars from VM to clipboard.`, "ok");
  });

  // Ensure restored font/theme applies once emulator terminal initializes.
  window.addEventListener("gl-emulator-ready", () => {
    const p = loadPrefs();
    if (typeof p.fontSize === "number") setFontSizeOverride(p.fontSize);
    if (p.theme && TERMINAL_THEMES[p.theme]) setTerminalTheme(p.theme);
  });

  // Two-finger pinch-to-zoom on #terminal
  const termEl = document.getElementById("terminal");
  if (termEl) {
    let pinchStartDist = 0;
    let pinchStartFont = 13;
    let lastPinchApplied = 0;
    const dist = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    termEl.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = dist(e.touches[0], e.touches[1]);
        pinchStartFont = getFontSizeOverride() || (window.innerWidth <= 480 ? 12 : 14);
        lastPinchApplied = pinchStartFont;
      }
    }, { passive: true });
    termEl.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinchStartDist > 10) {
        const d = dist(e.touches[0], e.touches[1]);
        const target = Math.max(10, Math.min(24, Math.round(pinchStartFont * (d / pinchStartDist))));
        if (target !== lastPinchApplied) {
          lastPinchApplied = target;
          setFontSizeOverride(target);
          savePrefs({ fontSize: target });
          updateFontLabel();
        }
      }
    }, { passive: true });
  }

  // Settings Modal wiring
  const modal = document.getElementById("settingsModal");
  const openBtn = document.getElementById("settingsBtn");
  const closeBtn = document.getElementById("closeSettings");
  const fontDec = document.getElementById("fontDecBtn");
  const fontInc = document.getElementById("fontIncBtn");
  const fontReset = document.getElementById("fontResetBtn");
  const themeRow = document.getElementById("themeSwatches");
  const zenBtn = document.getElementById("settingsZenBtn");
  const zenExitBtn = document.getElementById("zenExitBtn");
  const transcriptBtn = document.getElementById("exportTranscriptBtn");
  const searchOpenBtn = document.getElementById("openSearchBtn");

  let releaseFocus = null;
  const syncThemeButtons = () => {
    if (!themeRow) return;
    const cur = getTerminalThemeId();
    for (const b of themeRow.querySelectorAll("[data-theme-id]")) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-id") === cur));
    }
  };
  const closeModal = () => {
    if (!modal) return;
    modal.classList.remove("visible");
    if (releaseFocus) { releaseFocus(); releaseFocus = null; }
  };
  const openModal = () => {
    if (!modal) return;
    updateFontLabel();
    syncThemeButtons();
    modal.classList.add("visible");
    releaseFocus = trapModalFocus(modal);
  };

  if (openBtn) openBtn.onclick = openModal;
  if (closeBtn) closeBtn.onclick = closeModal;
  if (modal) {
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  }
  if (fontDec) fontDec.onclick = () => adjustFontSize(-1);
  if (fontInc) fontInc.onclick = () => adjustFontSize(1);
  if (fontReset) fontReset.onclick = () => resetFontSize();
  if (themeRow) {
    themeRow.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-theme-id]");
      if (!btn) return;
      const id = btn.getAttribute("data-theme-id");
      setTerminalTheme(id);
      savePrefs({ theme: id });
      syncThemeButtons();
    });
  }
  if (zenBtn) zenBtn.onclick = () => { toggleZenMode(); closeModal(); };
  if (zenExitBtn) zenExitBtn.onclick = () => setZenMode(false);
  if (transcriptBtn) transcriptBtn.onclick = () => { downloadTranscriptFile(); closeModal(); };

  // Scrollback Search Bar
  const searchBar = document.getElementById("searchBar");
  const searchInput = document.getElementById("searchInput");
  const searchCount = document.getElementById("searchCount");
  const searchPrev = document.getElementById("searchPrev");
  const searchNext = document.getElementById("searchNext");
  const searchClose = document.getElementById("searchClose");
  let matches = [];
  let matchIdx = -1;

  const runSearch = () => {
    const q = searchInput ? searchInput.value : "";
    matches = q ? searchScrollback(q) : [];
    matchIdx = matches.length ? matches.length - 1 : -1;
    if (searchCount) {
      searchCount.textContent = matches.length ? `${matchIdx + 1}/${matches.length}` : (q ? "0/0" : "");
    }
    if (matchIdx >= 0) scrollToBufferLine(matches[matchIdx].row);
  };
  const stepSearch = (dir) => {
    if (!matches.length) return;
    matchIdx = (matchIdx + dir + matches.length) % matches.length;
    if (searchCount) searchCount.textContent = `${matchIdx + 1}/${matches.length}`;
    scrollToBufferLine(matches[matchIdx].row);
  };
  openSearchFn = () => {
    if (!searchBar) return;
    searchBar.hidden = false;
    searchBar.classList.add("visible");
    if (searchInput) { searchInput.focus(); searchInput.select(); }
  };
  const closeSearch = () => {
    if (!searchBar) return;
    searchBar.hidden = true;
    searchBar.classList.remove("visible");
    const term = currentTerminal();
    if (term && typeof term.focus === "function") term.focus();
  };

  if (searchOpenBtn) searchOpenBtn.onclick = () => { closeModal(); openSearchFn(); };
  if (searchInput) {
    searchInput.addEventListener("input", runSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    });
  }
  if (searchPrev) searchPrev.onclick = () => stepSearch(-1);
  if (searchNext) searchNext.onclick = () => stepSearch(1);
  if (searchClose) searchClose.onclick = closeSearch;

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && modal.classList.contains("visible")) {
      closeModal();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearchFn();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (e.key === "=" || e.key === "+") { e.preventDefault(); adjustFontSize(1); }
      else if (e.key === "-") { e.preventDefault(); adjustFontSize(-1); }
      else if (e.key === "0") { e.preventDefault(); resetFontSize(); }
    }
    if (e.key === "F11") {
      e.preventDefault();
      toggleZenMode();
    }
  });
}
