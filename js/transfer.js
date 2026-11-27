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
import { buildZipBytes, extractZipEntries, sanitizeZipRelPath } from "./workspace-zip.js";

export const UPLOAD_LIMIT = 50 * 1024 * 1024;
export const MOBILE_UPLOAD_LIMIT = 15 * 1024 * 1024;
export const LARGE_HOME_UPLOAD_BYTES = 10 * 1024 * 1024;
export const QUICK_EDIT_MAX_BYTES = 256 * 1024;

function uploadLimitBytes() {
  const isMobile = (typeof window !== "undefined") &&
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) &&
    Math.min(screen.width, screen.height) < 820;
  return isMobile ? MOBILE_UPLOAD_LIMIT : UPLOAD_LIMIT;
}

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

/** Write a file at a relative path under ~ (/root), creating subdirectories as needed. */
export async function writeRelativeRootFile(emu, relPath, data) {
  const clean = sanitizeZipRelPath(relPath);
  if (!clean) throw new Error("unsafe path: " + relPath);
  const fs = emu && emu.fs9p;
  const rootId = findRootDirId(fs);
  if (!(rootId > 0) || !fs || typeof fs.CreateDirectory !== "function") {
    return writeUploadedFile(emu, sanitizeFilename(clean), data);
  }
  const parts = clean.split("/");
  const fileName = parts.pop();
  let dirId = rootId;
  let prefix = "/root/";
  for (const seg of parts) {
    let nextId = typeof fs.Search === "function" ? fs.Search(dirId, seg) : -1;
    if (nextId < 0) {
      nextId = fs.CreateDirectory(seg, dirId);
    } else if (!fs.inodes[nextId] || ((fs.inodes[nextId].mode & S_IFMT) !== S_IFDIR)) {
      throw new Error(`cannot create directory over file: ${seg}`);
    }
    dirId = nextId;
    prefix += seg + "/";
  }
  const existingId = typeof fs.Search === "function" ? fs.Search(dirId, fileName) : -1;
  if (existingId > 0 && fs.inodes[existingId]) {
    if ((fs.inodes[existingId].mode & S_IFMT) === S_IFDIR) {
      throw new Error(`cannot overwrite directory ~/${clean}`);
    }
    if (typeof fs.Unlink === "function") fs.Unlink(dirId, fileName);
    if (fs.inodedata && existingId in fs.inodedata) delete fs.inodedata[existingId];
  }
  await emu.create_file(prefix + fileName, data);
  if (typeof window !== "undefined" && window.GoPersist && window.GoPersist.markDirty) {
    window.GoPersist.markDirty();
  }
  return { dirId, prefix, guestDir: "~", persistent: true, path: clean };
}

export function deleteRootItem(emu, relPath) {
  const clean = sanitizeZipRelPath(relPath);
  const fs = emu && emu.fs9p;
  const rootId = findRootDirId(fs);
  if (!clean || !(rootId > 0) || !fs) return false;
  const parts = clean.split("/");
  const fileName = parts.pop();
  let dirId = rootId;
  for (const seg of parts) {
    dirId = typeof fs.Search === "function" ? fs.Search(dirId, seg) : -1;
    if (dirId < 0) return false;
  }
  const targetId = typeof fs.Search === "function" ? fs.Search(dirId, fileName) : -1;
  if (targetId < 0) return false;
  if (typeof fs.Unlink === "function") fs.Unlink(dirId, fileName);
  if (fs.inodedata && targetId in fs.inodedata) delete fs.inodedata[targetId];
  if (typeof window !== "undefined" && window.GoPersist && window.GoPersist.markDirty) {
    window.GoPersist.markDirty();
  }
  return true;
}

export async function renameRootItem(emu, oldRelPath, newNameRaw) {
  const newName = sanitizeFilename(newNameRaw);
  const cleanOld = sanitizeZipRelPath(oldRelPath);
  if (!cleanOld || !newName) throw new Error("invalid filename");
  const data = await emu.read_file("/root/" + cleanOld);
  if (!data) throw new Error("file not found");
  const parts = cleanOld.split("/");
  parts.pop();
  const newRel = parts.length ? `${parts.join("/")}/${newName}` : newName;
  if (newRel === cleanOld) return newRel;
  await writeRelativeRootFile(emu, newRel, data);
  deleteRootItem(emu, cleanOld);
  return newRel;
}

export async function exportRootAsZip(emu) {
  if (!emu || !emu.fs9p) throw new Error("VM not ready");
  const rootId = findRootDirId(emu.fs9p);
  if (!(rootId > 0)) throw new Error("/root 9p filesystem unavailable");
  const files = walkRegularFiles(emu.fs9p, rootId, { skipRootDefaults: true });
  if (!files.length) return null;
  const entries = [];
  for (const f of files) {
    const data = await emu.read_file("/root/" + f.path);
    if (data) entries.push({ path: f.path, data });
  }
  return buildZipBytes(entries);
}

export async function uploadFiles(fileList) {
  const emu = window.emulator;
  if (!emu || uploadInFlight) return;

  const files = Array.from(fileList || []);
  if (!files.length) return;

  const maxUpload = uploadLimitBytes();
  uploadInFlight = true;
  try {
    for (const file of files) {
      if (file.size > maxUpload) {
        setPersistStatus(
          `"${file.name}" is ${humanSize(file.size)} — limit on this device is ${humanSize(maxUpload)}.`,
          "error"
        );
        continue;
      }
      const relPath = file._glRelPath ? sanitizeZipRelPath(file._glRelPath) : null;
      const safeName = sanitizeFilename(file.name);
      try {
        setPersistStatus(`Uploading ${relPath || safeName}…`, "");
        const ab = await file.arrayBuffer();
        const data = new Uint8Array(ab);

        if (!relPath && /\.zip$/i.test(safeName) && data.byteLength <= 20 * 1024 * 1024) {
          const wantExtract = typeof window.confirm === "function" &&
            window.confirm(`Extract "${safeName}" directly into ~ (/root)?\n\nOK = Extract files into ~/\nCancel = Upload the .zip archive as-is`);
          if (wantExtract) {
            const entries = await extractZipEntries(data);
            for (const entry of entries) {
              await writeRelativeRootFile(emu, entry.path, entry.data);
            }
            setPersistStatus(`Extracted ${entries.length} files from ${safeName} into ~/.`, "ok");
            continue;
          }
        }

        const target = relPath
          ? await writeRelativeRootFile(emu, relPath, data)
          : await writeUploadedFile(emu, safeName, data);
        if (target.persistent) {
          setPersistStatus(`Uploaded ${relPath || safeName} -> ~/${relPath || safeName} (auto-saved).`, "ok");
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

function isLikelyText(bytes) {
  const len = Math.min(bytes.length, 4096);
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

function setupDownloadModal(trapModalFocus) {
  const modal = document.getElementById("filesModal");
  const listEl = document.getElementById("filesList");
  const statusEl = document.getElementById("filesStatus");
  const openBtn = document.getElementById("downloadBtn");
  const closeBtn = document.getElementById("closeFiles");
  const refreshBtn = document.getElementById("refreshFiles");
  const zipBtn = document.getElementById("downloadZipBtn");
  const editorPane = document.getElementById("fileEditorPane");
  const editorNameEl = document.getElementById("fileEditorName");
  const editorArea = document.getElementById("fileEditorText");
  const editorSaveBtn = document.getElementById("fileEditorSave");
  const editorBackBtn = document.getElementById("fileEditorBack");
  const filesFooter = document.getElementById("filesFooter");
  if (!modal || !listEl || !openBtn) return;

  let editingEntry = null;
  let releaseFocus = null;

  function showListPane() {
    editingEntry = null;
    if (editorPane) editorPane.hidden = true;
    listEl.hidden = false;
    if (filesFooter) filesFooter.hidden = false;
  }

  async function openEditor(entry) {
    const emu = window.emulator;
    if (!emu || !editorPane || !editorArea) return;
    try {
      const data = await emu.read_file(entry.fsPath);
      if (!data) throw new Error("file not found");
      if (data.byteLength > QUICK_EDIT_MAX_BYTES) {
        if (statusEl) { statusEl.textContent = "File too large for quick editor (> 256 KB)."; statusEl.className = "error"; }
        return;
      }
      if (!isLikelyText(data)) {
        if (statusEl) { statusEl.textContent = "Binary file cannot be edited as text."; statusEl.className = "error"; }
        return;
      }
      editingEntry = entry;
      if (editorNameEl) editorNameEl.textContent = entry.displayPath;
      editorArea.value = new TextDecoder("utf-8", { fatal: false }).decode(data);
      listEl.hidden = true;
      if (filesFooter) filesFooter.hidden = true;
      editorPane.hidden = false;
      editorArea.focus();
    } catch (e) {
      if (statusEl) { statusEl.textContent = "Could not open file: " + e.message; statusEl.className = "error"; }
    }
  }

  function renderFiles() {
    showListPane();
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

      const acts = document.createElement("div");
      acts.className = "hf-actions";

      if (f.area === "root" && f.size <= QUICK_EDIT_MAX_BYTES) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "hf-sec";
        editBtn.textContent = "Edit";
        editBtn.onclick = () => openEditor(f);
        acts.appendChild(editBtn);

        const renBtn = document.createElement("button");
        renBtn.type = "button";
        renBtn.className = "hf-sec";
        renBtn.textContent = "Rename";
        renBtn.onclick = async () => {
          const next = window.prompt(`Rename "${f.name}" to:`, f.name);
          if (!next || next === f.name) return;
          try {
            await renameRootItem(window.emulator, f.path, next);
            renderFiles();
            if (statusEl) { statusEl.textContent = `Renamed to ${sanitizeFilename(next)}.`; statusEl.className = "ok"; }
          } catch (e) {
            if (statusEl) { statusEl.textContent = "Rename failed: " + e.message; statusEl.className = "error"; }
          }
        };
        acts.appendChild(renBtn);

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "hf-del";
        delBtn.textContent = "Delete";
        delBtn.onclick = () => {
          if (!window.confirm(`Delete ~/${f.path}?`)) return;
          deleteRootItem(window.emulator, f.path);
          renderFiles();
          if (statusEl) { statusEl.textContent = `Deleted ~/${f.path}.`; statusEl.className = "ok"; }
        };
        acts.appendChild(delBtn);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Download";
      btn.setAttribute("data-download-path", f.path);
      btn.setAttribute("data-download-area", f.area);
      btn.onclick = () => downloadHostFile(f, f.size, statusEl);
      acts.appendChild(btn);

      row.appendChild(info);
      row.appendChild(acts);
      listEl.appendChild(row);
    }
  }

  if (editorBackBtn) editorBackBtn.onclick = showListPane;
  if (editorSaveBtn) {
    editorSaveBtn.onclick = async () => {
      const emu = window.emulator;
      if (!emu || !editingEntry || !editorArea) return;
      try {
        const bytes = new TextEncoder().encode(editorArea.value);
        await writeRelativeRootFile(emu, editingEntry.path, bytes);
        renderFiles();
        if (statusEl) { statusEl.textContent = `Saved ${editingEntry.displayPath} (${humanSize(bytes.byteLength)}).`; statusEl.className = "ok"; }
      } catch (e) {
        if (statusEl) { statusEl.textContent = "Save failed: " + e.message; statusEl.className = "error"; }
      }
    };
  }

  if (zipBtn) {
    zipBtn.onclick = async () => {
      const emu = window.emulator;
      if (!emu) return;
      try {
        if (statusEl) { statusEl.textContent = "Packing ~ into .zip…"; statusEl.className = ""; }
        const zipBytes = await exportRootAsZip(emu);
        if (!zipBytes) {
          if (statusEl) { statusEl.textContent = "No user files in ~ to export."; statusEl.className = ""; }
          return;
        }
        const blob = new Blob([zipBytes], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `golinux-workspace-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        if (statusEl) { statusEl.textContent = `Exported workspace.zip (${humanSize(zipBytes.byteLength)}).`; statusEl.className = "ok"; }
      } catch (e) {
        if (statusEl) { statusEl.textContent = "Export failed: " + e.message; statusEl.className = "error"; }
      }
    };
  }

  const close = () => {
    modal.classList.remove("visible");
    if (releaseFocus) { releaseFocus(); releaseFocus = null; }
  };

  openBtn.onclick = () => {
    renderFiles();
    modal.classList.add("visible");
    if (typeof trapModalFocus === "function") releaseFocus = trapModalFocus(modal);
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

async function collectDroppedFiles(dataTransfer) {
  const out = [];
  const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const hasEntryApi = items.some((it) => typeof it.webkitGetAsEntry === "function");
  if (!hasEntryApi) {
    return Array.from((dataTransfer && dataTransfer.files) || []);
  }
  async function walkEntry(entry, prefix) {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise((res) => {
        entry.file((f) => {
          if (prefix) f._glRelPath = prefix + "/" + f.name;
          out.push(f);
          res();
        }, () => res());
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch || !batch.length) break;
        for (const child of batch) await walkEntry(child, nextPrefix);
      }
    }
  }
  for (const it of items) {
    const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (entry) await walkEntry(entry, "");
    else {
      const f = it.getAsFile && it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export function setupTransferUI({ trapModalFocus } = {}) {
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
    const dropOverlay = document.getElementById("dropOverlay");
    let dragDepth = 0;
    if (term) {
      term.addEventListener("dragenter", (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
        e.preventDefault();
        dragDepth++;
        if (dropOverlay) dropOverlay.hidden = false;
      });
      term.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dropOverlay && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
          dropOverlay.hidden = false;
        }
      });
      term.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0 && dropOverlay) dropOverlay.hidden = true;
      });
      term.addEventListener("drop", async (e) => {
        e.preventDefault();
        dragDepth = 0;
        if (dropOverlay) dropOverlay.hidden = true;
        const files = await collectDroppedFiles(e.dataTransfer);
        if (files.length) await uploadFiles(files);
      });
    }
  }

  if (GL_FEATURES.download) {
    setupDownloadModal(trapModalFocus);
  }
}
