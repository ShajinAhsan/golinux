/* Zero-dependency ZIP reader & writer for ~/ (/root) workspace export/import.
 *
 * Uses native CompressionStream("deflate-raw") / DecompressionStream("deflate-raw")
 * when available, falling back to uncompressed Store (method 0) cleanly.
 * Strictly validates entry paths (no traversal, no absolute paths, capped file
 * count and total uncompressed bytes).
 */

const MAX_ZIP_FILES = 500;
const MAX_ZIP_UNCOMPRESSED = 25 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function sanitizeZipRelPath(raw) {
  if (typeof raw !== "string" || raw.includes("\0")) return null;
  const norm = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.endsWith("/")) return null;
  const segs = norm.split("/").filter(Boolean);
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === "." || s === ".." || /[\x00-\x1f\x7f]/.test(s)) return null;
  }
  return segs.join("/");
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined" || bytes.byteLength < 64) {
    return { method: 0, data: bytes };
  }
  try {
    const cs = new CompressionStream("deflate-raw");
    const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
    if (out.byteLength < bytes.byteLength) return { method: 8, data: out };
  } catch (_) {}
  return { method: 0, data: bytes };
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream('deflate-raw') is not supported in this browser");
  }
  const ds = new DecompressionStream("deflate-raw");
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      total += value.byteLength;
      if (total > MAX_ZIP_UNCOMPRESSED) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error("ZIP contents exceed 25 MB limit");
      }
      parts.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

/**
 * Build a standard PKZIP archive from [{ path, data: Uint8Array }].
 * Returns Uint8Array.
 */
export async function buildZipBytes(entries) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries || []) {
    const clean = sanitizeZipRelPath(entry.path);
    if (!clean) continue;
    const raw = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || 0);
    const nameBytes = enc.encode(clean);
    const crc = crc32(raw);
    const { method, data } = await deflateRaw(raw);

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x5421, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    const cdfh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdfh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5421, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, raw.byteLength, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdfh.set(nameBytes, 46);

    localParts.push(lfh, data);
    centralParts.push(cdfh);
    offset += lfh.byteLength + data.byteLength;
    count++;
  }

  let cdSize = 0;
  for (const c of centralParts) cdSize += c.byteLength;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(offset + cdSize + eocd.byteLength);
  let pos = 0;
  for (const p of localParts) { out.set(p, pos); pos += p.byteLength; }
  for (const p of centralParts) { out.set(p, pos); pos += p.byteLength; }
  out.set(eocd, pos);
  return out;
}

/**
 * Safely parse a PKZIP archive buffer into [{ path, data: Uint8Array }].
 */
export async function extractZipEntries(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder("utf-8", { fatal: false });

  // Locate End of Central Directory (EOCD)
  let eocdOff = -1;
  const minOff = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minOff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("Invalid ZIP archive (missing EOCD)");

  const totalEntries = dv.getUint16(eocdOff + 10, true);
  const cdSize = dv.getUint32(eocdOff + 12, true);
  const cdOff = dv.getUint32(eocdOff + 16, true);
  if (totalEntries > MAX_ZIP_FILES) throw new Error(`ZIP has too many files (max ${MAX_ZIP_FILES})`);
  if (cdOff + cdSize > eocdOff) throw new Error("Corrupt ZIP central directory");

  const entries = [];
  let totalOut = 0;
  let pos = cdOff;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > bytes.byteLength || dv.getUint32(pos, true) !== 0x02014b50) {
      throw new Error("Corrupt ZIP central directory entry");
    }
    const method = dv.getUint16(pos + 10, true);
    const compSize = dv.getUint32(pos + 20, true);
    const uncompSize = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const cmtLen = dv.getUint16(pos + 32, true);
    const localOff = dv.getUint32(pos + 42, true);
    const rawName = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + cmtLen;

    if (rawName.endsWith("/")) continue;
    const clean = sanitizeZipRelPath(rawName);
    if (!clean) throw new Error(`Unsafe path in ZIP: ${rawName}`);

    totalOut += uncompSize;
    if (totalOut > MAX_ZIP_UNCOMPRESSED) {
      throw new Error("ZIP uncompressed size exceeds 25 MB limit");
    }

    if (localOff + 30 > bytes.byteLength || dv.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP local header for ${clean}`);
    }
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.byteLength) throw new Error(`Truncated ZIP entry: ${clean}`);

    const compSlice = bytes.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = compSlice.slice();
    } else if (method === 8) {
      data = await inflateRaw(compSlice);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${clean}`);
    }
    entries.push({ path: clean, data });
  }
  return entries;
}
