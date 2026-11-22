#!/usr/bin/env node
/**
 * Guard against a v86 upgrade silently breaking the 9p state-stripping wrapper.
 *
 * persist-9p.js does not patch v86; it relies on two things:
 *   1. emulator.fs9p exists and exposes `.inodedata` and `.inodes`
 *   2. FS.get_state() returns 5+ slots, where slot [2] is [inodeId, Uint8Array]
 *      pairs holding file CONTENTS
 *
 * If an upgrade changes either, uploads would quietly end up back in the state
 * image (bloating every autosave) instead of failing loudly. This test boots the
 * real emulator, drives a real upload through create_file(), and asserts the
 * shape and the stripping behaviour.
 *
 * Usage: node tools/test/check-9p-state-shape.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets", "v86", "libv86.js"));

let serial = "";
let phase = 0;
let failed = false;
const fail = (msg) => { failed = true; console.error("FAIL: " + msg); };
const pass = (msg) => console.log("ok: " + msg);

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets", "v86", "v86.wasm"),
  bios: { url: path.join(ROOT, "assets", "bios", "seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets", "bios", "vgabios.bin") },
  bzimage: { url: path.join(ROOT, "images", "debian-bzImage") },
  initrd: { url: path.join(ROOT, "images", "debian-initrd") },
  hda: {
    url: path.join(ROOT, "images", "debian.img"),
    async: true,
    size: 5 * 1024 * 1024 * 1024,
  },
  filesystem: {},
  cmdline: "root=/dev/sda rw console=ttyS0",
  memory_size: 256 * 1024 * 1024,
  autostart: true,
});

emulator.add_listener("serial0-output-byte", (byte) => {
  serial += String.fromCharCode(byte);
  if (phase === 0 && /root@golinux:~#/.test(serial)) {
    phase = 1;
    run();
  }
});

async function run() {
  try {
    // --- 1. the handles the wrapper depends on exist -----------------------
    const fs9p = emulator.fs9p;
    if (!fs9p) throw new Error("emulator.fs9p is missing");
    pass("emulator.fs9p exists");

    for (const key of ["inodedata", "inodes", "get_state"]) {
      if (!(key in fs9p)) throw new Error("fs9p." + key + " is missing");
    }
    pass("fs9p exposes inodedata, inodes, get_state");

    // --- 2. create a real upload through the public API --------------------
    const PAYLOAD = 512 * 1024;
    const data = new Uint8Array(PAYLOAD);
    for (let i = 0; i < PAYLOAD; i++) data[i] = (i * 7) & 0xff;
    await emulator.create_file("/shape-probe.bin", data);

    const beforeCount = Object.keys(fs9p.inodedata).length;
    if (beforeCount === 0) throw new Error("create_file did not populate inodedata");
    pass("create_file() populated inodedata (" + beforeCount + " entr" +
      (beforeCount === 1 ? "y" : "ies") + ")");

    // --- 3. directory inodes must expose direntries as a Map --------------
    const rootInode = fs9p.inodes[0];
    if (!rootInode) throw new Error("fs9p.inodes[0] is missing");
    if (!(rootInode.direntries instanceof Map)) {
      throw new Error("root inode.direntries is not a Map; the empty-tree " +
        "stripping in persist-9p.js must be updated");
    }
    pass("directory inodes expose direntries as a Map");

    if (![...rootInode.direntries.keys()].length) {
      throw new Error("root direntries is empty; cannot verify stripping");
    }
    pass("root direntries is populated (" + rootInode.direntries.size + " entries)");

    // --- 4. get_state() shape: [2] must be [id, Uint8Array] pairs ----------
    const state = fs9p.get_state();
    if (!Array.isArray(state) || state.length < 5) {
      throw new Error("FS.get_state() no longer returns 5+ slots (got " +
        (state && state.length) + "); persist-9p.js must be updated");
    }
    pass("FS.get_state() returns " + state.length + " slots");

    if (!Array.isArray(state[2])) {
      throw new Error("FS.get_state()[2] is no longer the file-data array; " +
        "persist-9p.js must be updated");
    }
    pass("FS.get_state()[2] is the file-data array");

    let sawPayload = false;
    for (const entry of state[2]) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("FS.get_state()[2] entries are not [id, data] pairs; " +
          "persist-9p.js must be updated");
      }
      if (typeof entry[0] !== "string") {
        throw new Error("FS.get_state()[2][i][0] is not a string inode id");
      }
      if (!(entry[1] instanceof Uint8Array)) {
        throw new Error("FS.get_state()[2][i][1] is not a Uint8Array; " +
          "persist-9p.js must be updated");
      }
      if (entry[1].byteLength === PAYLOAD) sawPayload = true;
    }
    if (!sawPayload) {
      throw new Error("the uploaded file's bytes were not found in " +
        "FS.get_state()[2]; uploads may no longer be stored there, so the " +
        "stripping wrapper would do nothing");
    }
    pass("uploaded bytes appear in FS.get_state()[2] (" + PAYLOAD + " bytes)");

    // --- 5. stripping empties contents AND directory entries --------------
    const inodeCount = state[0].length;
    const saved = fs9p.inodedata;
    fs9p.inodedata = {};
    const stripped = fs9p.get_state();
    fs9p.inodedata = saved;

    if (stripped[2].length !== 0) {
      throw new Error("clearing inodedata did not empty state[2] (still " +
        stripped[2].length + " entries)");
    }
    pass("clearing inodedata empties state[2]");

    // Clearing contents alone would leave directory entries pointing at files
    // with no data, which the guest would list as empty files. The wrapper
    // also clears direntries, so assert that produces an empty tree.
    if (stripped[0].length !== inodeCount) {
      throw new Error("clearing inodedata changed the inode count (" +
        inodeCount + " -> " + stripped[0].length + ")");
    }
    pass("inode tree preserved (" + inodeCount + " inodes)");

    // Every non-root directory must keep only "." and ".." once stripped.
    const namesAfterStrip = (inodeState) => {
      const dirs = inodeState.filter((i) => (i[0] & 0xf000) === 0x4000);
      return dirs.flatMap((i) => (i[1] || []).map(([name]) => name));
    };
    const keptNames = new Set(namesAfterStrip(stripped[0]));
    const extra = [...keptNames].filter((n) => n !== "." && n !== "..");
    if (extra.length) {
      throw new Error("stripped state still contains directory entries: " +
        extra.join(", "));
    }
    pass("stripped state has no file entries in any directory");

    // --- 6. the wrapper actually shrinks a real save_state() --------------
    const { loadPersist9p } = require("./load-persist-9p.js");
    loadPersist9p(globalThis);
    const uninstall = globalThis.Go9p.install(emulator);

    const wrapped = await emulator.save_state();
    const restoredSaved = fs9p.inodedata;
    if (Object.keys(restoredSaved).length !== beforeCount) {
      throw new Error("inodedata was not restored after save_state()");
    }
    pass("wrapper restored inodedata after save_state()");

    const unwrapped = await (async () => {
      uninstall();
      const s = await emulator.save_state();
      globalThis.Go9p.install(emulator);
      return s;
    })();

    const delta = unwrapped.byteLength - wrapped.byteLength;
    if (delta < PAYLOAD) {
      throw new Error("wrapped save_state is only " + delta +
        " bytes smaller; expected at least the " + PAYLOAD + "-byte upload");
    }
    pass("wrapped state is " + (delta / 1024).toFixed(0) +
      " KiB smaller than unwrapped");

    console.log("\nAll 9p state-shape checks passed.");
  } catch (e) {
    fail(e.message);
  } finally {
    emulator.stop();
    process.exit(failed ? 1 : 0);
  }
}

setTimeout(() => {
  console.error("TIMEOUT: no shell prompt; cannot verify 9p state shape");
  process.exit(1);
}, 180000);
