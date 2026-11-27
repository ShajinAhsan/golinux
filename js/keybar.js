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

const APP_CURSOR_SEQUENCES = Object.freeze({
  up: "\x1bOA",
  down: "\x1bOB",
  right: "\x1bOC",
  left: "\x1bOD",
});

function isTermComposing(term) {
  return !!(term && term._core && term._core._compositionHelper &&
            term._core._compositionHelper.isComposing);
}

function clearHelperTextarea(term, force) {
  const ta = term && (term.textarea || (term.element &&
    term.element.querySelector(".xterm-helper-textarea")));
  if (!ta || ta.value === "") return;
  if (!force && isTermComposing(term)) return;
  ta.value = "";
}

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
  const hint = document.getElementById("kbLatchHint");
  if (hint) {
    const parts = [];
    if (latchedCtrl) parts.push("Ctrl+");
    if (latchedAlt) parts.push("Alt+");
    hint.textContent = parts.join("");
    hint.hidden = parts.length === 0;
  }
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

  let xtermNativeSeq = 0;
  let seqAtCycleStart = 0;
  let compStartSeq = 0;
  let lastXtermNativeAt = 0;
  let lastKeydownAt = 0;
  let lastLineBreakAt = 0;
  let fallbackSending = false;
  let clearTaTimer = null;

  function sendFallback(str) {
    if (!str || typeof term.input !== "function") return;
    fallbackSending = true;
    try {
      term.input(str);
    } finally {
      fallbackSending = false;
    }
  }

  // Dispose any prior textarea IME listeners on Restart.
  if (adapter._glImeDispose) {
    try { adapter._glImeDispose(); } catch (e) {}
    adapter._glImeDispose = null;
  }

  // Android Chrome + Gboard IME guard:
  // xterm.js 5.x drops `InputEvent(insertText, composed:true)` once _keyDownSeen
  // is true, and CompositionHelper drops/corrupts input whenever textarea.value
  // retains stale text from prior lines or #keybar taps. Track native xterm
  // onData ticks and recover dropped inputs without ever double-sending.
  const ta = term.textarea || (term.element &&
    term.element.querySelector(".xterm-helper-textarea"));
  if (ta) {
    const onKeyDown = () => {
      seqAtCycleStart = xtermNativeSeq;
      lastKeydownAt = performance.now();
    };
    const onCompStart = () => {
      compStartSeq = xtermNativeSeq;
    };
    const onBeforeInput = (e) => {
      const now = performance.now();
      if (now - lastXtermNativeAt < 5) return;
      if (now - lastKeydownAt > 50) {
        seqAtCycleStart = xtermNativeSeq;
      }
      if (e.inputType === "insertLineBreak") {
        lastLineBreakAt = now;
      }
      if (e.inputType === "deleteContentBackward") {
        const snap = seqAtCycleStart;
        setTimeout(() => {
          if (xtermNativeSeq === snap && !isTermComposing(term)) {
            sendFallback("\x7f");
            clearHelperTextarea(term, false);
          }
        }, 25);
      }
    };
    const onInput = (e) => {
      const now = performance.now();
      if (now - lastXtermNativeAt < 5) return;
      if (e.inputType === "insertLineBreak") {
        lastLineBreakAt = now;
        if (xtermNativeSeq !== seqAtCycleStart) return;
        const snap = seqAtCycleStart;
        setTimeout(() => {
          if (xtermNativeSeq === snap && !isTermComposing(term)) {
            sendFallback("\r");
            clearHelperTextarea(term, false);
          }
        }, 25);
        return;
      }
      if (e.inputType === "insertText" && e.data && !isTermComposing(term)) {
        if (xtermNativeSeq !== seqAtCycleStart) return;
        const text = e.data;
        const snap = seqAtCycleStart;
        setTimeout(() => {
          if (xtermNativeSeq === snap && !isTermComposing(term)) {
            sendFallback(text);
            clearHelperTextarea(term, false);
          }
        }, 25);
      }
    };
    const onCompEnd = (e) => {
      const text = (e && e.data) || "";
      const snap = compStartSeq;
      setTimeout(() => {
        if (text.length > 0 && xtermNativeSeq === snap && !isTermComposing(term)) {
          sendFallback(text);
        }
        clearHelperTextarea(term, false);
      }, 25);
    };

    ta.addEventListener("keydown", onKeyDown, true);
    ta.addEventListener("compositionstart", onCompStart, true);
    ta.addEventListener("beforeinput", onBeforeInput, true);
    ta.addEventListener("input", onInput, false);
    ta.addEventListener("compositionend", onCompEnd, false);
    adapter._glImeDispose = () => {
      ta.removeEventListener("keydown", onKeyDown, true);
      ta.removeEventListener("compositionstart", onCompStart, true);
      ta.removeEventListener("beforeinput", onBeforeInput, true);
      ta.removeEventListener("input", onInput, false);
      ta.removeEventListener("compositionend", onCompEnd, false);
    };
  }

  adapter.on_data_disposable = term.onData((raw) => {
    if (!fallbackSending) {
      xtermNativeSeq++;
      lastXtermNativeAt = performance.now();
    }
    let data = raw;
    // Normalize single LF from Android Gboard insertLineBreak to CR so nano
    // inserts a newline instead of triggering Ctrl-J (Justify paragraph).
    if (data === "\n" && performance.now() - lastLineBreakAt < 60) {
      data = "\r";
    }
    if ((latchedCtrl || latchedAlt) && data.length === 1) {
      data = applyModifiers(data, { ctrl: latchedCtrl, alt: latchedAlt });
      clearLatches();
    } else if (latchedCtrl || latchedAlt) {
      clearLatches();
    }

    const bytes = encoder.encode(data);
    if (isVirtio) {
      for (const b of bytes) pending.push(b);
      if (!drainTimer) flushVirtio();
    } else {
      for (const b of bytes) emulator.bus.send("serial0-input", b);
    }

    if (ta && !isTermComposing(term)) {
      clearTimeout(clearTaTimer);
      clearTaTimer = setTimeout(() => clearHelperTextarea(term, false), 0);
    }
  });
}

function sendToTerm(str, clearTa = false) {
  const term = currentTerminal();
  if (!term) return;
  try {
    if (typeof term.input === "function") {
      term.input(str);
    }
    if (clearTa) clearHelperTextarea(term, true);
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

  if (act === "copy") {
    const term = currentTerminal();
    const sel = term && typeof term.getSelection === "function" ? term.getSelection() : "";
    if (sel && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(sel).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1000);
    }
    return;
  }

  if (act === "paste") {
    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      navigator.clipboard.readText().then((txt) => {
        if (txt) sendToTerm(txt, false);
      }).catch(() => {});
    }
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
    sendToTerm("\x1b", true);
    return;
  }

  if (KEY_SEQUENCES[act]) {
    clearLatches();
    const term = currentTerminal();
    const seq = (APP_CURSOR_SEQUENCES[act] && term && term.modes &&
                 term.modes.applicationCursorKeysMode)
      ? APP_CURSOR_SEQUENCES[act]
      : KEY_SEQUENCES[act];
    sendToTerm(seq, true);
    return;
  }

  if (sym !== undefined) {
    // Let term.onData apply any latched Ctrl/Alt once so it is never double-applied.
    sendToTerm(sym, false);
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

  window.addEventListener("blur", () => clearLatches());
}
