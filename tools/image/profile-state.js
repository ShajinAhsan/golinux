#!/usr/bin/env node
// Profile a v86 state file by component.
//
// v86's save_state() (src/state.js) builds:
//   header (16 B): magic, version, total_len, info_len
//   info_block: JSON { buffer_infos: [{offset,length}], state: [...] }
//   buffer_block: every typed array's bytes, back to back
// `state` is CPU.get_state() (src/cpu.js), and its numeric indices map to
// components. We resolve each buffer_id back to the component that owns it and
// sum its byte length, so the breakdown comes from the file itself rather than
// from guesses.
//
// Usage: node tools/image/profile-state.js <state-file>
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const FILE = process.argv[2] || path.join(__dirname, "..", "..", "images", "debian-state.bin");

const STATE_INFO_BLOCK_START = 16;

// CPU.get_state() index -> component, transcribed from src/cpu.js.
const CPU_STATE_LABELS = {
  0: "cpu.flags",
  1: "cpu.segment_flags",
  2: "cpu.segment_offsets",
  3: "cpu.segment_limits",
  4: "cpu.protected_mode",
  10: "cpu.cr",
  37: "cpu.instruction_pointer",
  39: "cpu.reg32",
  40: "cpu.sreg",
  41: "cpu.dreg",
  43: "cpu.tsc",
  45: "dev.virtio_9p",
  46: "dev.apic",
  47: "dev.rtc",
  48: "dev.pci",
  49: "dev.dma",
  50: "dev.acpi",
  52: "dev.vga",
  53: "dev.ps2",
  54: "dev.uart0",
  55: "dev.fdc",
  56: "dev.ide.atapi",
  57: "dev.ide",
  58: "dev.pit",
  59: "dev.net",
  60: "dev.pic",
  61: "dev.sb16",
  63: "dev.ioapic",
  66: "cpu.reg_xmm32s",
  67: "cpu.fpu_st",
  77: "MEMORY (packed, nonzero pages)",
  78: "MEMORY (page bitmap)",
  79: "dev.uart1",
  80: "dev.uart2",
  81: "dev.uart3",
  82: "dev.virtio_console",
  83: "dev.virtio_net",
  84: "dev.virtio_balloon",
  85: "dev.ide (full)",
  89: "dev.vmware",
};

function parseState(buf) {
  const header = new Int32Array(buf.buffer, buf.byteOffset, 4);
  const totalLen = header[2];
  const infoLen = header[3];
  const info = JSON.parse(
    new TextDecoder().decode(buf.subarray(STATE_INFO_BLOCK_START, STATE_INFO_BLOCK_START + infoLen)));
  return { totalLen, infoLen, info };
}

/** Collect every buffer_id referenced anywhere under `node`. */
function collectBufferIds(node, out = new Set()) {
  if (typeof node !== "object" || node === null) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectBufferIds(v, out);
    return out;
  }
  if (typeof node["buffer_id"] === "number") {
    out.add(node["buffer_id"]);
    return out;
  }
  for (const k of Object.keys(node)) collectBufferIds(node[k], out);
  return out;
}

const raw = fs.readFileSync(FILE);
const buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
const { totalLen, infoLen, info } = parseState(buf);

const dataStart = STATE_INFO_BLOCK_START + infoLen;
const headerBytes = STATE_INFO_BLOCK_START + Math.ceil(infoLen / 4) * 4 - STATE_INFO_BLOCK_START;

const rows = [];
let accounted = 0;

for (const [key, value] of Object.entries(info.state)) {
  const ids = collectBufferIds(value);
  let bytes = 0;
  for (const id of ids) {
    const bi = info.buffer_infos[id];
    if (bi) bytes += bi.length;
  }
  accounted += bytes;
  if (bytes > 0) {
    rows.push({ label: CPU_STATE_LABELS[key] || `state[${key}]`, bytes, buffers: ids.size });
  }
}

rows.sort((a, b) => b.bytes - a.bytes);

const MB = n => (n / 1048576).toFixed(1);
const pct = n => ((n / totalLen) * 100).toFixed(1) + "%";

console.log(`file:            ${FILE}`);
console.log(`total (raw):     ${MB(totalLen)} MiB (${totalLen} bytes)`);
console.log(`  info block:    ${MB(infoLen)} MiB`);
console.log(`  buffer block:  ${MB(totalLen - dataStart)} MiB`);
console.log(`  buffers:       ${info.buffer_infos.length}`);
console.log("");
console.log("component breakdown (non-zero contributions, by raw bytes):");
for (const r of rows.slice(0, 16)) {
  console.log(`  ${String(MB(r.bytes)).padStart(7)} MiB  ${pct(r.bytes).padStart(6)}  ${r.label}` +
    `  (${r.buffers} buffer${r.buffers === 1 ? "" : "s"})`);
}
console.log("");
console.log(`sum of all component buffers: ${MB(accounted)} MiB`);

// How much of the packed memory is distinct pages vs. zeros is not derivable
// from the file, but the bitmap tells us how many pages were kept.
const memState = info.state[78];
if (memState && memState.buffer_id !== undefined) {
  const bitmapBuf = info.buffer_infos[memState.buffer_id];
  if (bitmapBuf) {
    const bits = bitmapBuf.length * 8;
    const packed = info.state[77];
    const packedBytes = packed && packed.buffer_id !== undefined
      ? info.buffer_infos[packed.buffer_id].length : 0;
    const kept = packedBytes / 4096;
    console.log(`guest RAM: ${kept} non-zero pages kept of ${bits} (${((kept / bits) * 100).toFixed(1)}%)`);
    console.log(`  => ${MB(packedBytes)} MiB of non-zero guest RAM is in the file;` +
      ` zero pages were already dropped by pack_memory()`);
  }
}
