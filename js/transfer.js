/* File transfer UI: Upload into /mnt/host and Option A Download from /mnt/host.
 *
 * INV-1: ZERO bytes are ever sent to guest stdin (no echo, no tar, no rm).
 *   - Upload: writes via emulator.create_file("/" + safeName, data) into the
 *     9p share (/mnt/host) and updates #persistStatus only.
 *   - Download: walks emulator.fs9p to list files in /mnt/host, checks size
 *     against device memory cap BEFORE reading, and downloads via
 *     emulator.read_file("/" + path).
 */

import { setPersistStatus } from "./status.js";

const UPLOAD_LIMIT = 50 * 1024 * 1024;
const UPLOAD_DIR = "/mnt/host";
const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const MAX_WALK_DEPTH = 4;

let uploadInFlight = false;
let downloadInFlight = false;

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

export function humanSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function downloadLimitBytes() {
  const isMobile = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) &&
                   Math.min(screen.width, screen.height) < 820;
  return isMobile ? 30 * 1024 * 1024 : 300 * 1024 * 1024;
}

function findHostDirId(fs) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return 0;
  if (typeof window !== "undefined" && window.Go9p && typeof window.Go9p.findHostDirId === "function") {
    const id = window.Go9p.findHostDirId(fs);
    if (id > 0) return id;
  }
  const root = fs.inodes[0];
  if (root && root.direntries instanceof Map) {
    const id = root.direntries.get("host");
    if (typeof id === "number" && id > 0 && fs.inodes[id] && ((fs.inodes[id].mode & S_IFMT) === S_IFDIR)) {
      return id;
    }
  }
  return 0;
}

function hostMountPrefix(fs) {
  return findHostDirId(fs) > 0 ? "/host/" : "/";
}

/**
 * List all regular files currently in v86's /mnt/host 9p share.
 * Pure traversal over fs.inodes (exported for unit testing).
 * Returns [{ path, name, size }] sorted alphabetically by path.
 */
export function listHostFiles(fs) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return [];
  const startId = findHostDirId(fs);
  const results = [];
  const visited = new Set();

  function walk(inodeId, prefix, depth) {
    if (depth > MAX_WALK_DEPTH || visited.has(inodeId)) return;
    const inode = fs.inodes[inodeId];
    if (!inode || !(inode.direntries instanceof Map)) return;
    visited.add(inodeId);

    for (const [name, childId] of inode.direntries.entries()) {
      if (name === "." || name === "..") continue;
      const child = fs.inodes[childId];
      if (!child || typeof child.mode !== "number") continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const kind = child.mode & S_IFMT;
      if (kind === S_IFDIR) {
        walk(childId, rel, depth + 1);
      } else if (kind === S_IFREG) {
        const size = typeof child.size === "number"
          ? child.size
          : (fs.inodedata && fs.inodedata[childId] ? fs.inodedata[childId].byteLength : 0);
        results.push({ path: rel, name, size });
      }
    }
  }

  walk(startId, "", 0);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
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
        await emu.create_file(hostMountPrefix(emu.fs9p) + safeName, data);
        setPersistStatus(
          `Uploaded ${safeName} -> ${UPLOAD_DIR}/${safeName} (temporary; cp to /root to keep).`,
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

export async function downloadHostFile(relPath, expectedSize, statusEl) {
  const emu = window.emulator;
  if (!emu || downloadInFlight) return false;

  const limit = downloadLimitBytes();
  if (typeof expectedSize === "number" && expectedSize > limit) {
    const msg = `"${relPath}" is ${humanSize(expectedSize)}, over the ${humanSize(limit)} limit on this device.`;
    if (statusEl) { statusEl.textContent = msg; statusEl.className = "error"; }
    setPersistStatus(msg, "error");
    return false;
  }

  downloadInFlight = true;
  try {
    if (statusEl) { statusEl.textContent = `Reading ${relPath}…`; statusEl.className = ""; }
    const data = await emu.read_file(hostMountPrefix(emu.fs9p) + relPath);
    if (!data) throw new Error("file not found in /mnt/host");
    if (data.byteLength > limit) {
      const msg = `"${relPath}" is ${humanSize(data.byteLength)}, over the ${humanSize(limit)} limit.`;
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "error"; }
      setPersistStatus(msg, "error");
      return false;
    }

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = relPath.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    const okMsg = `Downloaded ${relPath} (${humanSize(blob.size)})`;
    if (statusEl) { statusEl.textContent = okMsg; statusEl.className = "ok"; }
    setPersistStatus(okMsg, "ok");
    return true;
  } catch (e) {
    const errMsg = `Download failed: ${(e && e.message) || e}`;
    if (statusEl) { statusEl.textContent = errMsg; statusEl.className = "error"; }
    setPersistStatus(errMsg, "error");
    return false;
  } finally {
    downloadInFlight = false;
  }
}

function setupDownloadModal() {
  const modal = document.getElementById("filesModal");
  const listEl = document.getElementById("filesList");
  const statusEl = document.getElementById("filesStatus");
  const openBtn = document.getElementById("downloadBtn");
  const closeBtn = document.getElementById("closeFiles");
  const refreshBtn = document.getElementById("refreshFiles");
  if (!modal || !listEl || !openBtn) return;

  function renderFiles() {
    if (statusEl) { statusEl.textContent = ""; statusEl.className = ""; }
    listEl.textContent = "";

    const emu = window.emulator;
    const files = emu && emu.fs9p ? listHostFiles(emu.fs9p) : [];

    if (!files.length) {
      const empty = document.createElement("div");
      empty.id = "filesEmpty";
      empty.textContent =
        "No files in /mnt/host yet. Copy a file from the terminal (e.g. cp file.txt /mnt/host/), then tap Refresh.";
      listEl.appendChild(empty);
      return;
    }

    for (const f of files) {
      const row = document.createElement("div");
      row.className = "host-file";

      const info = document.createElement("div");
      info.className = "hf-info";
      const nameEl = document.createElement("div");
      nameEl.className = "hf-name";
      nameEl.textContent = f.path;
      const sizeEl = document.createElement("div");
      sizeEl.className = "hf-size";
      sizeEl.textContent = humanSize(f.size);
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Download";
      btn.setAttribute("data-download-path", f.path);
      btn.onclick = () => downloadHostFile(f.path, f.size, statusEl);

      row.appendChild(info);
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  }

  const close = () => modal.classList.remove("visible");

  openBtn.onclick = () => {
    renderFiles();
    modal.classList.add("visible");
  };
  if (refreshBtn) refreshBtn.onclick = renderFiles;
  if (closeBtn) closeBtn.onclick = close;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("visible")) close();
  });
}

export function setupTransferUI() {
  if (GL_FEATURES.upload) {
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

  if (GL_FEATURES.download) {
    setupDownloadModal();
  }
}
