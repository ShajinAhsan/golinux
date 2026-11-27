/* Command Palette (Ctrl+K / ?), Quick Starter Recipes, and Safe URL Share Import.
 *
 * INV-1 compliant: zero automatic bytes sent to guest stdin. Starter recipes
 * copy to clipboard or insert only on explicit user click; URL hash shares
 * (#file=...&code=...) always ask confirmation before writing into ~/ via 9p.
 */

import { adjustFontSize, downloadTranscriptFile, openScrollbackSearch, resetFontSize, toggleZenMode } from "./settings.js";
import { setTerminalTheme, currentTerminal } from "./terminal.js";
import { restartMachine } from "./boot.js";
import { sanitizeFilename, writeUploadedFile } from "./transfer.js";
import { setPersistStatus } from "./status.js";

const SHARE_MAX_BYTES = 64 * 1024;

/** Pure URL hash parser (exported for unit tests). */
export function parseShareHash(hashStr) {
  const h = String(hashStr || "").replace(/^#/, "");
  if (!h || !h.includes("code=")) return null;
  const params = new URLSearchParams(h);
  const rawCode = params.get("code");
  if (!rawCode) return null;
  const rawFile = params.get("file") || "snippet.txt";
  const file = sanitizeFilename(rawFile);
  try {
    const norm = rawCode.replace(/-/g, "+").replace(/_/g, "/");
    const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
    const bin = atob(pad);
    if (bin.length === 0 || bin.length > SHARE_MAX_BYTES) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { file, bytes };
  } catch (_) {
    return null;
  }
}

const RECIPES = [
  { id: "r-c", title: "Compile & run C with TinyCC", cmd: "cat << 'EOF' > hello.c\n#include <stdio.h>\nint main(){ puts(\"Hello GoLinux!\"); return 0; }\nEOF\ntcc hello.c -o hello && ./hello", kind: "recipe" },
  { id: "r-py", title: "Run Python 3 one-liner", cmd: "python3 -c 'import sys, math; print(sys.version.split()[0], math.pi)'", kind: "recipe" },
  { id: "r-ff", title: "Show system info (fastfetch)", cmd: "fastfetch", kind: "recipe" },
  { id: "r-clip", title: "Copy output to host clipboard (clip)", cmd: "uname -a | clip", kind: "recipe" },
  { id: "r-git", title: "Initialize a local Git repo", cmd: "mkdir proj && cd proj && git init", kind: "recipe" },
  { id: "r-tmux", title: "Start split terminal session (tmux)", cmd: "tmux", kind: "recipe" },
];

export function setupPalette({ trapModalFocus, getInstallPrompt } = {}) {
  const modal = document.getElementById("paletteModal");
  const openBtn = document.getElementById("paletteBtn");
  const closeBtn = document.getElementById("closePalette");
  const input = document.getElementById("paletteInput");
  const listEl = document.getElementById("paletteList");

  const actions = [
    { id: "a-upload", title: "Upload files or .zip into ~ (/root)", run: () => document.getElementById("uploadBtn")?.click() },
    { id: "a-files", title: "Open File Manager & Editor (~/ & /mnt/host)", run: () => document.getElementById("downloadBtn")?.click() },
    { id: "a-zip", title: "Download entire ~ workspace as .zip", run: () => document.getElementById("downloadZipBtn")?.click() },
    { id: "a-tools", title: "Open Tools, Bandwidth Mode & Offline Packs", run: () => document.getElementById("openPacks")?.click() },
    { id: "a-search", title: "Search terminal scrollback (Ctrl+Shift+F)", run: () => openScrollbackSearch() },
    { id: "a-transcript", title: "Export terminal transcript (.txt)", run: () => downloadTranscriptFile() },
    { id: "a-zen", title: "Toggle Zen / Fullscreen mode (F11)", run: () => toggleZenMode() },
    { id: "a-font-inc", title: "Increase terminal font size (Ctrl+=)", run: () => adjustFontSize(1) },
    { id: "a-font-dec", title: "Decrease terminal font size (Ctrl+-)", run: () => adjustFontSize(-1) },
    { id: "a-font-rst", title: "Reset terminal font size (Ctrl+0)", run: () => resetFontSize() },
    { id: "a-theme-obs", title: "Theme: Obsidian Dark", run: () => setTerminalTheme("obsidian") },
    { id: "a-theme-sol", title: "Theme: Solarized Dark", run: () => setTerminalTheme("solarized") },
    { id: "a-theme-lit", title: "Theme: Light High-Contrast", run: () => setTerminalTheme("light") },
    { id: "a-theme-ret", title: "Theme: Retro Phosphor Green", run: () => setTerminalTheme("retro") },
    { id: "a-save", title: "Save ~ (/root) now", run: () => document.getElementById("saveBtn")?.click() },
    { id: "a-restart", title: "Restart VM (keep ~ files)", run: () => restartMachine() },
    { id: "a-settings", title: "Open Terminal Settings", run: () => document.getElementById("settingsBtn")?.click() },
  ];

  let releaseFocus = null;
  let selectedIdx = 0;
  let visibleItems = [];

  function close() {
    if (!modal) return;
    modal.classList.remove("visible");
    if (releaseFocus) { releaseFocus(); releaseFocus = null; }
  }

  function currentItems() {
    const items = actions.slice();
    const promptEv = typeof getInstallPrompt === "function" ? getInstallPrompt() : null;
    if (promptEv) {
      items.unshift({
        id: "a-pwa",
        title: "Install GoLinux as Offline App (PWA)",
        run: async () => { try { await promptEv.prompt(); } catch (_) {} },
      });
    }
    return items.concat(RECIPES);
  }

  function render() {
    if (!listEl) return;
    const q = (input ? input.value : "").trim().toLowerCase();
    const all = currentItems();
    visibleItems = q
      ? all.filter((it) => it.title.toLowerCase().includes(q) || (it.cmd && it.cmd.toLowerCase().includes(q)))
      : all;
    if (selectedIdx >= visibleItems.length) selectedIdx = Math.max(0, visibleItems.length - 1);

    listEl.textContent = "";
    visibleItems.forEach((it, idx) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pal-item" + (idx === selectedIdx ? " active" : "");
      const title = document.createElement("span");
      title.className = "pal-title";
      title.textContent = it.title;
      const badge = document.createElement("span");
      badge.className = "pal-badge";
      badge.textContent = it.kind === "recipe" ? "Copy snippet" : "Action";
      row.append(title, badge);
      row.onclick = () => executeItem(it);
      listEl.appendChild(row);
    });
  }

  function executeItem(it) {
    close();
    if (it.kind === "recipe") {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(it.cmd).then(() => {
          setPersistStatus(`Copied snippet: ${it.title}`, "ok");
        }).catch(() => {});
      }
      const term = currentTerminal();
      if (term && typeof term.focus === "function") term.focus();
      return;
    }
    if (typeof it.run === "function") it.run();
  }

  function open() {
    if (!modal) return;
    if (input) input.value = "";
    selectedIdx = 0;
    render();
    modal.classList.add("visible");
    if (typeof trapModalFocus === "function") releaseFocus = trapModalFocus(modal);
    if (input) input.focus();
  }

  if (openBtn) openBtn.onclick = open;
  if (closeBtn) closeBtn.onclick = close;
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  if (input) {
    input.addEventListener("input", () => { selectedIdx = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); selectedIdx = Math.min(visibleItems.length - 1, selectedIdx + 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selectedIdx = Math.max(0, selectedIdx - 1); render(); }
      else if (e.key === "Enter" && visibleItems[selectedIdx]) { e.preventDefault(); executeItem(visibleItems[selectedIdx]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (modal && modal.classList.contains("visible")) close();
      else open();
    } else if (e.key === "Escape" && modal && modal.classList.contains("visible")) {
      close();
    }
  });

  // Safe URL Hash Share Import (#file=...&code=...)
  window.addEventListener("gl-emulator-ready", () => {
    const parsed = parseShareHash(location.hash);
    if (!parsed) return;
    const shareModal = document.getElementById("shareImportModal");
    const nameEl = document.getElementById("shareFileName");
    const previewEl = document.getElementById("sharePreview");
    const acceptBtn = document.getElementById("shareAcceptBtn");
    const cancelBtn = document.getElementById("shareCancelBtn");
    if (!shareModal || !acceptBtn || !cancelBtn) return;

    if (nameEl) nameEl.textContent = `~/${parsed.file} (${parsed.bytes.byteLength} bytes)`;
    if (previewEl) {
      const txt = new TextDecoder("utf-8", { fatal: false }).decode(parsed.bytes.subarray(0, 1200));
      previewEl.textContent = txt + (parsed.bytes.byteLength > 1200 ? "\n…" : "");
    }
    shareModal.classList.add("visible");
    const rel = typeof trapModalFocus === "function" ? trapModalFocus(shareModal) : null;
    const dismiss = () => {
      shareModal.classList.remove("visible");
      if (rel) rel();
      try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    };
    cancelBtn.onclick = dismiss;
    acceptBtn.onclick = async () => {
      const emu = window.emulator;
      if (emu) {
        await writeUploadedFile(emu, parsed.file, parsed.bytes);
        setPersistStatus(`Imported ~/${parsed.file} from link.`, "ok");
      }
      dismiss();
    };
  });
}
