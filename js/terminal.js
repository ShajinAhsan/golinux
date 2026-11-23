/* Terminal sizing, visualViewport mobile sync, and out-of-band virtio-console resize.
 *
 * INV-1: NEVER sends anything to guest stdin (no stty, no Ctrl-L, no serial0_send).
 * Resizing updates xterm.js and sends v86's native out-of-band virtio control
 * message ("virtio-console0-resize"), which delivers SIGWINCH directly to
 * Linux /dev/hvc0 without touching stdin or erasing output.
 */

export const MIN_COLS = 20;
export const MIN_ROWS = 5;

let getEmulator = () => window.emulator;
let appliedCols = 0;
let appliedRows = 0;
let resizeScheduled = false;

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

/** Pick comfortable terminal font size for phone vs desktop. */
function syncFontSize(term) {
  if (!term || !term.options) return;
  const want = window.innerWidth <= 480 ? 12 : 14;
  if (term.options.fontSize !== want) {
    term.options.fontSize = want;
  }
}

let resizeRetryTimer = null;

function sendVirtioResize(emu, cols, rows) {
  if (!emu || !emu.virtio_console_adapter || !emu.bus) return;
  const dev = emu.v86 && emu.v86.cpu && emu.v86.cpu.devices && emu.v86.cpu.devices.virtio_console;
  const q2 = dev && dev.virtio && dev.virtio.queues && dev.virtio.queues[2];
  if (q2 && (!q2.is_configured() || !q2.has_request())) {
    clearTimeout(resizeRetryTimer);
    resizeRetryTimer = setTimeout(() => sendVirtioResize(emu, appliedCols, appliedRows), 60);
    return;
  }
  try {
    emu.bus.send("virtio-console0-resize", [cols, rows]);
  } catch (e) { /* guest not ready yet */ }
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
  sendVirtioResize(getEmulator(), cols, rows);
}

export function fitTerminal(force) {
  const term = currentTerminal();
  if (!term) return;
  syncFontSize(term);
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

export function fitSoon() {
  appliedCols = 0;
  appliedRows = 0;
  requestAnimationFrame(() => {
    fitTerminal(true);
    requestAnimationFrame(() => fitTerminal(false));
  });
  setTimeout(() => fitTerminal(false), 300);
  setTimeout(() => fitTerminal(false), 900);
}

/** Keep #app pinned to visualViewport so iOS Safari soft keyboard never covers #keybar. */
export function syncVisualViewport() {
  const app = document.getElementById("app");
  if (!app) return;
  const vv = window.visualViewport;
  if (vv && vv.height > 0) {
    document.documentElement.style.setProperty("--app-h", Math.round(vv.height) + "px");
    app.style.transform = vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  } else {
    document.documentElement.style.setProperty("--app-h", window.innerHeight + "px");
    app.style.transform = "";
  }
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
