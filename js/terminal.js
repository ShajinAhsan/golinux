/* Terminal sizing, visualViewport mobile sync, and out-of-band virtio-console resize.
 *
 * INV-1: NEVER sends anything to guest stdin (no stty, no Ctrl-L, no serial0_send).
 * Resizing updates xterm.js and sends v86's native out-of-band virtio control
 * message ("virtio-console0-resize"), which delivers SIGWINCH directly to
 * Linux /dev/hvc0 without touching stdin or erasing output.
 */

export const MIN_COLS = 20;
export const MIN_ROWS = 5;

/** Curated vibrant dark ANSI palette (zero extra runtime CPU/RAM overhead). */
export const TERMINAL_THEME = Object.freeze({
  background: "#080b11",
  foreground: "#e2e8f0",
  cursor: "#34d399",
  cursorAccent: "#080b11",
  selectionBackground: "rgba(56, 189, 248, 0.26)",
  black: "#1e293b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
});

let getEmulator = () => window.emulator;
let appliedCols = 0;
let appliedRows = 0;
let resizeScheduled = false;
let themedTerm = null;

export function setEmulatorGetter(fn) {
  getEmulator = fn;
}

export function currentAdapter() {
  const emu = getEmulator();
  if (!emu) return null;
  return emu.virtio_console_adapter || emu.serial_adapter || null;
}

export function currentTerminal() {
  const ad = currentAdapter();
  return ad ? ad.term : null;
}

/** Pure grid math (exported for unit tests). */
export function computeGrid(availW, availH, cellW, cellH) {
  if (!(availW > 0) || !(availH > 0) || !(cellW > 0) || !(cellH > 0)) return null;
  return {
    cols: Math.max(MIN_COLS, Math.floor(availW / cellW)),
    rows: Math.max(MIN_ROWS, Math.floor(availH / cellH)),
  };
}

export function cellSize(term) {
  try {
    const core = term._core || term.__core || null;
    const rs = core && core._renderService;
    const dims = rs && rs.dimensions && rs.dimensions.css;
    if (dims && dims.cell && dims.cell.width > 0 && dims.cell.height > 0) {
      return { w: dims.cell.width, h: dims.cell.height };
    }
    if (rs && rs._charSizeService && rs._charSizeService.hasValidSize) {
      const cw = rs._charSizeService.width;
      const ch = rs._charSizeService.height;
      if (cw > 0 && ch > 0) return { w: cw, h: ch };
    }
  } catch (e) { /* fall through */ }

  try {
    const row = document.querySelector("#terminal .xterm-rows > div");
    if (row && term.cols > 0) {
      const r = row.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) {
        return { w: r.width / term.cols, h: r.height };
      }
    }
  } catch (e) { /* fall through */ }

  const fontSize = (term && term.options && term.options.fontSize) || 13;
  return { w: fontSize * 0.6, h: fontSize * 1.25 };
}

export function desiredGrid() {
  const term = currentTerminal();
  const el = document.getElementById("terminal");
  if (!term || !el) return null;
  const cs = getComputedStyle(el);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const cell = cellSize(term);
  return computeGrid(el.clientWidth - padX, el.clientHeight - padY, cell.w, cell.h);
}

/** Apply vibrant theme, responsive font size, and alternate-buffer resize flush. */
function syncTerminalStyle(term) {
  if (!term || !term.options) return;
  if (themedTerm !== term) {
    themedTerm = term;
    term.options.theme = TERMINAL_THEME;
    term.options.fontFamily = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace';
    term.options.lineHeight = 1.26;
    term.options.cursorBlink = true;
    term.options.cursorStyle = "bar";

    const ta = term.textarea;
    if (ta) {
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("spellcheck", "false");
      ta.setAttribute("enterkeyhint", "enter");
    }

    // When a full-screen TUI (nano, vi, less, man, htop, tmux) enters the
    // alternate screen buffer, flush any deferred height-only resize once
    // the app finishes initscr()/signal_init() so it catches SIGWINCH and
    // redraws its bottom bar to the exact keyboard-adjusted row count.
    if (term.buffer && typeof term.buffer.onBufferChange === "function") {
      term.buffer.onBufferChange((buf) => {
        clearTimeout(altFlushTimer);
        altFlushTimer = null;
        if (buf && buf.type === "alternate" && appliedCols > 0 && appliedRows > 0 &&
            (appliedCols !== lastSentCols || appliedRows !== lastSentRows)) {
          altFlushTimer = setTimeout(() => {
            altFlushTimer = null;
            if (!isAlternateBuffer(currentTerminal())) return;
            if (appliedCols === lastSentCols && appliedRows === lastSentRows) return;
            clearTimeout(resizeDebounceTimer);
            resizeDebounceTimer = null;
            sendVirtioResizeNow(getEmulator(), appliedCols, appliedRows);
          }, 220);
        }
      });
    }
  }
  const want = window.innerWidth <= 480 ? 12 : 14;
  if (term.options.fontSize !== want) {
    term.options.fontSize = want;
  }
}

function isAlternateBuffer(term) {
  return !!(term && term.buffer && term.buffer.active && term.buffer.active.type === "alternate");
}

let resizeRetryTimer = null;
let resizeDebounceTimer = null;
let altFlushTimer = null;
let lastSentCols = 0;
let lastSentRows = 0;
const VIRTIO_RESIZE_DEBOUNCE_MS = 220;

function sendVirtioResizeNow(emu, cols, rows) {
  if (!emu || !emu.virtio_console_adapter || !emu.bus) return;
  const dev = emu.v86 && emu.v86.cpu && emu.v86.cpu.devices && emu.v86.cpu.devices.virtio_console;
  const q2 = dev && dev.virtio && dev.virtio.queues && dev.virtio.queues[2];
  if (q2 && (!q2.is_configured() || !q2.has_request())) {
    clearTimeout(resizeRetryTimer);
    resizeRetryTimer = setTimeout(() => sendVirtioResizeNow(getEmulator(), appliedCols, appliedRows), 60);
    return;
  }
  try {
    lastSentCols = cols;
    lastSentRows = rows;
    emu.bus.send("virtio-console0-resize", [cols, rows]);
  } catch (e) { /* guest not ready yet */ }
}

/**
 * Send out-of-band SIGWINCH without flickering the shell prompt on mobile.
 *
 * - On height-only changes (cols unchanged, e.g. mobile soft keyboard open,
 *   close, or size change) while in the normal shell buffer, xterm.js already
 *   handles viewport height locally; sending SIGWINCH would force Bash/Readline
 *   to erase (\r\e[K) and slowly retype root@golinux:~# byte-by-byte. So we
 *   defer the guest resize and flush it immediately if a full-screen TUI
 *   enters the alternate buffer.
 * - Width changes (cols !== lastSentCols) and resizes while inside a full-screen
 *   TUI (alternate buffer) are debounced so animations send one clean SIGWINCH.
 */
function scheduleVirtioResize(emu, cols, rows, immediate) {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = null;
  if (immediate) {
    sendVirtioResizeNow(emu, cols, rows);
    return;
  }
  if (lastSentCols > 0 && cols === lastSentCols && !isAlternateBuffer(currentTerminal())) {
    return;
  }
  resizeDebounceTimer = setTimeout(() => {
    resizeDebounceTimer = null;
    if (appliedCols === lastSentCols && appliedRows === lastSentRows) return;
    if (lastSentCols > 0 && appliedCols === lastSentCols && !isAlternateBuffer(currentTerminal())) return;
    sendVirtioResizeNow(getEmulator(), appliedCols, appliedRows);
  }, VIRTIO_RESIZE_DEBOUNCE_MS);
}

/** Resize xterm.js and notify guest via out-of-band virtio-console0-resize. */
export function applyGrid(cols, rows, force) {
  const term = currentTerminal();
  if (!term) return;
  if (!force && cols === appliedCols && rows === appliedRows) return;

  appliedCols = cols;
  appliedRows = rows;

  try {
    term.resize(cols, rows);
  } catch (e) {
    console.warn("terminal resize failed:", e);
    return;
  }

  // Out-of-band virtio-console resize (SIGWINCH to /dev/hvc0, zero stdin bytes).
  scheduleVirtioResize(getEmulator(), cols, rows, !!force);
}

export function fitTerminal(force) {
  const term = currentTerminal();
  if (!term) return;
  syncTerminalStyle(term);
  const g = desiredGrid();
  if (!g) return;
  applyGrid(g.cols, g.rows, !!force);
}

export function scheduleFit() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    fitTerminal(false);
  });
}

export function fitSoon({ nudgeRedraw = false } = {}) {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = null;
  clearTimeout(altFlushTimer);
  altFlushTimer = null;
  appliedCols = 0;
  appliedRows = 0;
  lastSentCols = 0;
  lastSentRows = 0;
  requestAnimationFrame(() => {
    fitTerminal(true);
    if (nudgeRedraw) {
      // Out-of-band SIGWINCH nudge (zero stdin bytes): if the restored VM
      // already has the exact same cols x rows, Linux skips SIGWINCH. Sending
      // rows-1 then rows makes bash redraw its real prompt (including cwd)
      // and makes nano/vim/less redraw cleanly.
      const emu = getEmulator();
      const c = appliedCols;
      const r = appliedRows;
      if (emu && emu.virtio_console_adapter && c > 0 && r > MIN_ROWS) {
        setTimeout(() => sendVirtioResizeNow(emu, c, r - 1), 80);
        setTimeout(() => sendVirtioResizeNow(emu, appliedCols || c, appliedRows || r), 160);
      }
    }
    requestAnimationFrame(() => fitTerminal(false));
  });
  setTimeout(() => fitTerminal(false), 350);
  setTimeout(() => fitTerminal(false), 900);
}

let lastVpH = -1;
let lastVpTop = -1;

/** Keep #app pinned to visualViewport so iOS Safari soft keyboard never covers #keybar. */
export function syncVisualViewport() {
  const app = document.getElementById("app");
  if (!app) return;
  const vv = window.visualViewport;
  const h = vv && vv.height > 0 ? Math.round(vv.height) : window.innerHeight;
  const top = vv && vv.offsetTop ? Math.round(vv.offsetTop) : 0;
  if (h === lastVpH && top === lastVpTop) return;
  lastVpH = h;
  lastVpTop = top;
  document.documentElement.style.setProperty("--app-h", h + "px");
  app.style.transform = top ? `translateY(${top}px)` : "";
  if (vv && window.scrollY !== 0) window.scrollTo(0, 0);
  scheduleFit();
}

let observed = false;

export function observeTerminal() {
  if (observed) return;
  observed = true;

  const el = document.getElementById("terminal");
  if (el && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(el);
  }

  window.addEventListener("resize", syncVisualViewport);
  window.addEventListener("orientationchange", () => {
    setTimeout(syncVisualViewport, 120);
    setTimeout(syncVisualViewport, 400);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncVisualViewport);
    window.visualViewport.addEventListener("scroll", syncVisualViewport);
  }

  // Synchronous focus inside pointerdown preserves iOS Safari's user-gesture
  // requirement so tapping the terminal raises the soft keyboard on first tap.
  if (el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest && e.target.closest("a, button")) return;
      const term = currentTerminal();
      if (term && typeof term.focus === "function") {
        try { term.focus(); } catch (err) {}
      }
    });
  }

  syncVisualViewport();
}
