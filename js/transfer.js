/* File transfer UI (flagged off by default via GL_FEATURES.upload / download).
 *
 * INV-1: NEVER sends shell commands to guest stdin (no echo, no tar, no rm).
 * Upload writes directly to v86's 9p share (/mnt/host/<safeName>) and reports
 * status in #persistStatus only. Download stays disabled until a non-stdin
 * export channel is implemented.
 */

import { setPersistStatus } from "./status.js";

const UPLOAD_LIMIT = 50 * 1024 * 1024;
const UPLOAD_DIR = "/mnt/host";
let uploadInFlight = false;

/** Sanitize an uploaded filename to a single safe path segment. */
export function sanitizeFilename(raw) {
  const base = String(raw || "upload")
    .split(/[\\/]/)
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .trim();
  if (!base || base === "." || base === "..") return "upload";
  return base;
}

function humanSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

export async function uploadFiles(fileList) {
  const emu = window.emulator;
  if (!emu || uploadInFlight) return;

  const files = Array.from(fileList || []);
  if (!files.length) return;

  uploadInFlight = true;
  try {
    for (const file of files) {
      if (file.size > UPLOAD_LIMIT) {
        setPersistStatus(
          `"${file.name}" is ${humanSize(file.size)} — limit is 50 MB.`,
          "error"
        );
        continue;
      }
      const safeName = sanitizeFilename(file.name);
      try {
        setPersistStatus(`Uploading ${safeName}…`, "");
        const data = new Uint8Array(await file.arrayBuffer());
        await emu.create_file("/" + safeName, data);
        setPersistStatus(
          `Uploaded ${safeName} to ${UPLOAD_DIR}/${safeName} (temporary; cp to /root to keep).`,
          "ok"
        );
      } catch (e) {
        setPersistStatus(`Upload failed: ${(e && e.message) || e}`, "error");
      }
    }
  } finally {
    uploadInFlight = false;
  }
}

export function setupTransferUI() {
  if (!GL_FEATURES.upload) return;

  const input = document.getElementById("uploadInput");
  const btn = document.getElementById("uploadBtn");
  if (btn && input) {
    btn.onclick = () => input.click();
    input.onchange = async () => {
      await uploadFiles(input.files);
      input.value = "";
    };
  }

  const term = document.getElementById("terminal");
  if (term) {
    term.addEventListener("dragover", (e) => e.preventDefault());
    term.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        await uploadFiles(e.dataTransfer.files);
      }
    });
  }
}
