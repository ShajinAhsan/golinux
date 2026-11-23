/* On-screen touch key bar & unified one-shot Ctrl/Alt modifier pipeline.
 *
 * Key fix (BUG-24): replaces v86's default xterm.onData listener so one-shot
 * Ctrl and Alt latches intercept BOTH keybar symbols AND native phone/desktop
 * keyboard input (e.g., tap Ctrl on keybar + press 'o' on iPhone keyboard ->
 * sends 0x0f Ctrl-O to save in nano, then disarms Ctrl).
 *
 * Also marks persistence dirty on every user keystroke/tap.
 */

import { currentAdapter, currentTerminal, scheduleFit } from "./terminal.js";

export const KEY_SEQUENCES = Object.freeze({
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  backspace: "\x7f",
});

/** Pure modifier transform (exported for unit tests). */
export function applyModifiers(str, { ctrl = false, alt = false } = {}) {
  if (!str || str.length !== 1) return str;
  let out = str;
  if (ctrl) {
    if (out === "?") {
      out = "\x7f";
    } else {
      const c = out.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    }
  }
  if (alt) {
    out = "\x1b" + out;
  }
  return out;
}

let latchedCtrl = false;
let latchedAlt = false;

export function getLatches() {
  return { ctrl: latchedCtrl, alt: latchedAlt };
}

export function setLatched(which, on) {
  if (which === "ctrl") latchedCtrl = !!on;
  if (which === "alt") latchedAlt = !!on;
  const btn = document.querySelector(`#keybar [data-act="${which}"]`);
  if (btn) btn.setAttribute("aria-pressed", String(!!on));
}

export function clearLatches() {
  setLatched("ctrl", false);
  setLatched("alt", false);
}

/**
 * Intercept xterm.onData on the active v86 console adapter so latched Ctrl/Alt
 * applies to native mobile keyboard typing as well as key-bar buttons.
 */
export function attachKeyboardInterceptor(emulator) {
  const adapter = currentAdapter();
  const term = currentTerminal();
  if (!emulator || !adapter || !term || !emulator.bus) return;

  if (adapter.on_data_disposable && typeof adapter.on_data_disposable.dispose === "function") {
    adapter.on_data_disposable.dispose();
  }

  const isVirtio = adapter === emulator.virtio_console_adapter;
  const encoder = new TextEncoder();

  // Flow-controlled RX queue for virtio-console: v86's virtio RX queue has
  // only 16 descriptors (size_supported: 16). Sending rapid single-byte
  // keystrokes or large pastes without checking has_request() silently drops
  // characters after the 16th byte. Buffer and drain in batches whenever a
  // descriptor is available so zero user input is ever dropped.
  let pending = [];
  let drainTimer = null;

  function virtioRxQueue() {
    const dev = emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices &&
                emulator.v86.cpu.devices.virtio_console;
    return dev && dev.virtio && dev.virtio.queues && dev.virtio.queues[0];
  }

  function flushVirtio() {
    drainTimer = null;
    if (!pending.length) return;
    const q = virtioRxQueue();
    // If we can inspect the queue and it has no free descriptor yet, wait
    // briefly for Linux's virtio_console IRQ handler to refill it.
    if (q && typeof q.has_request === "function" && !q.has_request()) {
      drainTimer = setTimeout(flushVirtio, 12);
      return;
    }
    const chunk = pending.splice(0, 256);
    emulator.bus.send("virtio-console0-input-bytes", new Uint8Array(chunk));
    if (pending.length) {
      drainTimer = setTimeout(flushVirtio, 12);
    }
  }

  adapter.on_data_disposable = term.onData((raw) => {
    let data = raw;
    if ((latchedCtrl || latchedAlt) && data.length === 1) {
      data = applyModifiers(data, { ctrl: latchedCtrl, alt: latchedAlt });
      clearLatches();
    } else if (latchedCtrl || latchedAlt) {
      clearLatches();
    }

    if (window.GoPersist && window.GoPersist.markDirty) {
      window.GoPersist.markDirty();
    }

    const bytes = encoder.encode(data);
    if (isVirtio) {
      for (const b of bytes) pending.push(b);
      if (!drainTimer) flushVirtio();
    } else {
      for (const b of bytes) emulator.bus.send("serial0-input", b);
    }
  });
}

function sendToTerm(str) {
  const term = currentTerminal();
  if (!term) return;
  try {
    if (typeof term.input === "function") {
      term.input(str);
    }
  } catch (e) {
    console.warn("key send failed:", e);
  }
}

export function toggleNativeKeyboard() {
  const term = currentTerminal();
  const ta = term && (term.textarea || (term.element &&
    term.element.querySelector(".xterm-helper-textarea")));
  if (!ta) return;
  if (document.activeElement === ta) {
    ta.blur();
  } else {
    term.focus();
  }
}

export function handleKeyButton(btn) {
  const act = btn.dataset.act;
  const sym = btn.dataset.sym;

  if (act === "ctrl" || act === "alt") {
    const now = act === "ctrl" ? !latchedCtrl : !latchedAlt;
    setLatched(act, now);
    return;
  }

  if (act === "keyboard") {
    toggleNativeKeyboard();
    return;
  }

  if (act === "more") {
    const extra = document.querySelector("#keybar .kb-extra");
    if (!extra) return;
    const show = extra.hidden;
    extra.hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
    scheduleFit();
    return;
  }

  if (act === "esc") {
    clearLatches();
    sendToTerm("\x1b");
    return;
  }

  if (KEY_SEQUENCES[act]) {
    clearLatches();
    sendToTerm(KEY_SEQUENCES[act]);
    return;
  }

  if (sym !== undefined) {
    // Let term.onData apply any latched Ctrl/Alt once so it is never double-applied.
    sendToTerm(sym);
  }
}

let keybarSetup = false;

export function setupKeyBar() {
  if (keybarSetup) return;
  keybarSetup = true;

  const bar = document.getElementById("keybar");
  if (!bar) return;

  const touch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
                ("ontouchstart" in window);
  if (touch) bar.classList.add("visible");

  bar.addEventListener("pointerdown", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("button");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    handleKeyButton(btn);
  }, { passive: false });

  bar.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const btn = e.target && e.target.closest && e.target.closest("button");
    if (!btn) return;
    e.preventDefault();
    handleKeyButton(btn);
  });
}
