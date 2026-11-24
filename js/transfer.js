/* File transfer UI: direct Upload/Drag-and-drop & Download for ~ (/root),
 * with automatic /mnt/host staging for large files (> 10 MB) so /root
 * autosaves stay fast and mobile-RAM safe.
 *
 * INV-1: ZERO bytes are ever sent to guest stdin (no echo, no tar, no rm).
 *   - Normal uploads (<= 10 MB): write directly into ~ (/root) via 9p
 *     create_file("/root/" + safeName, data) and auto-save to OPFS.
 *   - Large uploads (> 10 MB, up to 50 MB): write to temporary /mnt/host
 *     so they never bloat every 350 ms /root autosave.
 *   - Download modal: lists user files directly from ~ (/root) plus any
 *     temporary files in /mnt/host, reading via emulator.read_file().
 */

import { setPersistStatus } from "./status.js";

export const UPLOAD_LIMIT = 50 * 1024 * 1024;
export const LARGE_HOME_UPLOAD_BYTES = 10 * 1024 * 1024;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const MAX_WALK_DEPTH = 4;
const SKIP_ROOT_FILES = new Set([".bash_profile", ".bashrc"]);
const SKIP_ROOT_DIRS = new Set([".cache", ".config"]);

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

function findSubdirId(fs, name) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return -1;
  if (typeof fs.Search === "function") {
    try {
      const id = fs.Search(0, name);
      if (typeof id === "number" && id > 0 && fs.inodes[id] && ((fs.inodes[id].mode & S_IFMT) === S_IFDIR)) {
        return id;
      }
    } catch (_) {}
  }
  const root = fs.inodes[0];
  if (root && root.direntries instanceof Map) {
    const id = root.direntries.get(name);
    if (typeof id === "number" && id > 0 && fs.inodes[id] && ((fs.inodes[id].mode & S_IFMT) === S_IFDIR)) {
      return id;
    }
  }
  return -1;
}

function findRootDirId(fs) {
  if (typeof window !== "undefined" && window.Go9p && typeof window.Go9p.findRootDirId === "function") {
    return window.Go9p.findRootDirId(fs);
  }
  return findSubdirId(fs, "root");
}

function findHostDirId(fs) {
  if (typeof window !== "undefined" && window.Go9p && typeof window.Go9p.findHostDirId === "function") {
    const id = window.Go9p.findHostDirId(fs);
    if (id > 0) return id;
  }
  const id = findSubdirId(fs, "host");
  return id > 0 ? id : 0;
}

function hostMountPrefix(fs) {
  return findHostDirId(fs) > 0 ? "/host/" : "/";
}

/**
 * Decide where an uploaded file should land:
 *   - <= 10 MB when 9p /root is mounted -> ~ (/root), auto-persisted.
 *   - > 10 MB (or cold-boot fallback without 9p /root) -> /mnt/host (temporary).
 */
export function resolveUploadTarget(fs, fileSize) {
  const rootId = findRootDirId(fs);
  const hostId = findHostDirId(fs);
  if (rootId > 0 && !(fileSize > LARGE_HOME_UPLOAD_BYTES)) {
    return {
      dirId: rootId,
      prefix: "/root/",
      guestDir: "~",
      persistent: true,
      reason: "home",
    };
  }
  return {
    dirId: hostId,
    prefix: hostId > 0 ? "/host/" : "/",
    guestDir: "/mnt/host",
    persistent: false,
    reason: rootId > 0 ? "large" : "fallback",
  };
}

function walkRegularFiles(fs, startId, { skipRootDefaults = false } = {}) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[startId]) return [];
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
      if (child.status === 4 || child.status === -1) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const kind = child.mode & S_IFMT;
      if (kind === S_IFDIR) {
        if (skipRootDefaults && depth === 0 && SKIP_ROOT_DIRS.has(name)) continue;
        walk(childId, rel, depth + 1);
      } else if (kind === S_IFREG) {
        if (skipRootDefaults && depth === 0 && SKIP_ROOT_FILES.has(name)) continue;
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

/**
 * List all regular files currently in v86's /mnt/host 9p share.
 * Pure traversal over fs.inodes (exported for unit testing).
 * Returns [{ path, name, size }] sorted alphabetically by path.
 */
export function listHostFiles(fs) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return [];
  return walkRegularFiles(fs, findHostDirId(fs));
}

/**
 * List downloadable files directly from ~ (/root) first, followed by any
 * temporary files in /mnt/host.
 * Returns [{ area, path, displayPath, fsPath, name, size }].
 */
export function listDownloadableFiles(fs) {
  if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return [];
  const items = [];
  const rootId = findRootDirId(fs);
  if (rootId > 0) {
    for (const f of walkRegularFiles(fs, rootId, { skipRootDefaults: true })) {
      items.push({
        area: "root",
        path: f.path,
        displayPath: "~/" + f.path,
        fsPath: "/root/" + f.path,
        name: f.name,
        size: f.size,
      });
    }
  }
  const hostPrefix = hostMountPrefix(fs);
  for (const f of walkRegularFiles(fs, findHostDirId(fs))) {
    items.push({
      area: "host",
      path: f.path,
      displayPath: "/mnt/host/" + f.path,
      fsPath: hostPrefix + f.path,
      name: f.name,
      size: f.size,
    });
  }
  return items;
}

/**
 * Write a single uploaded file into ~ (/root) or /mnt/host cleanly:
 *   - Refuses to overwrite an existing directory.
 *   - Unlinks any existing regular file/symlink first and frees its inodedata
 *     buffer (prevents v86 CreateBinaryFile RAM leak on re-uploads).
 */
export async function writeUploadedFile(emu, safeName, data) {
  const fs = emu && emu.fs9p;
  const target = resolveUploadTarget(fs, data.byteLength);

  if (fs && Array.isArray(fs.inodes) && fs.inodes[target.dirId]) {
    const dir = fs.inodes[target.dirId];
    const existingId = typeof fs.Search === "function"
      ? fs.Search(target.dirId, safeName)
      : (dir.direntries instanceof Map && dir.direntries.has(safeName) ? dir.direntries.get(safeName) : -1);
    if (existingId > 0 && fs.inodes[existingId]) {
      if ((fs.inodes[existingId].mode & S_IFMT) === S_IFDIR) {
        throw new Error(`cannot overwrite directory ${target.guestDir}/${safeName}`);
      }
      if (typeof fs.Unlink === "function") {
        fs.Unlink(target.dirId, safeName);
      } else if (dir.direntries instanceof Map) {
        dir.direntries.delete(safeName);
      }
      if (fs.inodedata && existingId in fs.inodedata) {
        delete fs.inodedata[existingId];
      }
    }
  }

  await emu.create_file(target.prefix + safeName, data);

  // CreateBinaryFile fires NotifyListeners("newfile") while size===0 before
  // set_data finishes; mark dirty after write completes so autosave captures bytes.
  if (target.persistent && typeof window !== "undefined" && window.GoPersist && window.GoPersist.markDirty) {
    window.GoPersist.markDirty();
  }
  return target;
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
        const target = await writeUploadedFile(emu, safeName, data);
        if (target.persistent) {
          setPersistStatus(`Uploaded ${safeName} -> ~/${safeName} (auto-saved).`, "ok");
        } else if (target.reason === "large") {
          setPersistStatus(
            `Uploaded ${safeName} (${humanSize(data.byteLength)}) -> /mnt/host/${safeName} ` +
            `(files > 10 MB stay temporary so ~ saves stay fast).`,
            "ok"
          );
        } else {
          setPersistStatus(
            `Uploaded ${safeName} -> /mnt/host/${safeName} (temporary; cp to ~ to keep).`,
            "ok"
          );
        }
      } catch (e) {
        setPersistStatus(`Upload failed: ${(e && e.message) || e}`, "error");
      }
    }
  } finally {
    uploadInFlight = false;
  }
}

export async function downloadHostFile(pathOrEntry, expectedSize, statusEl) {
  const emu = window.emulator;
  if (!emu || downloadInFlight) return false;

  const isEntry = pathOrEntry && typeof pathOrEntry === "object";
  const label = isEntry ? (pathOrEntry.displayPath || pathOrEntry.path) : String(pathOrEntry || "");
  const fsPath = isEntry ? pathOrEntry.fsPath : (hostMountPrefix(emu.fs9p) + label);
  const sizeHint = isEntry ? pathOrEntry.size : expectedSize;

  const limit = downloadLimitBytes();
  if (typeof sizeHint === "number" && sizeHint > limit) {
    const msg = `"${label}" is ${humanSize(sizeHint)}, over the ${humanSize(limit)} limit on this device.`;
    if (statusEl) { statusEl.textContent = msg; statusEl.className = "error"; }
    setPersistStatus(msg, "error");
    return false;
  }

  downloadInFlight = true;
  try {
    if (statusEl) { statusEl.textContent = `Reading ${label}…`; statusEl.className = ""; }
    const data = await emu.read_file(fsPath);
    if (!data) throw new Error("file not found: " + label);
    if (data.byteLength > limit) {
      const msg = `"${label}" is ${humanSize(data.byteLength)}, over the ${humanSize(limit)} limit.`;
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "error"; }
      setPersistStatus(msg, "error");
      return false;
    }

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (isEntry ? pathOrEntry.name : label.split("/").pop()) || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    const okMsg = `Downloaded ${label} (${humanSize(blob.size)})`;
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
    const files = emu && emu.fs9p ? listDownloadableFiles(emu.fs9p) : [];

    if (!files.length) {
      const empty = document.createElement("div");
      empty.id = "filesEmpty";
      empty.textContent =
        "No user files in ~ (/root) or /mnt/host yet. Create a file in ~ (or copy one into /mnt/host/), then tap Refresh.";
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
      nameEl.textContent = f.displayPath;
      const sizeEl = document.createElement("div");
      sizeEl.className = "hf-size";
      sizeEl.textContent = humanSize(f.size) + (f.area === "host" ? " · temporary" : "");
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Download";
      btn.setAttribute("data-download-path", f.path);
      btn.setAttribute("data-download-area", f.area);
      btn.onclick = () => downloadHostFile(f, f.size, statusEl);

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
