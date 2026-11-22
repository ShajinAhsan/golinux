#!/usr/bin/env node
// Proof: does a user-created state capture guest file changes?
//
// v86 serves the disk from read-only chunks, so every guest write lands in the
// IDE write-back block cache (block_cache_is_write). save_state() serialises
// that cache, so a state taken after the user writes files should still have
// them when restored into a fresh instance.
//
// This test: boot from the shipped snapshot -> create files + compile ->
// save_state -> restore into a NEW instance -> verify the files and binary.
//
// Usage: node tools/image/experiment-persist.js
'use strict';

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const SNAPSHOT = path.join(ROOT, "images/debian-state.bin.zst");
const OUT_RAW = path.join(os.tmpdir(), "user-state-raw.bin");
const OUT_ZST = OUT_RAW + ".zst";
const OUT_GZ = OUT_RAW + ".gz";

function makeEmulator(initialStateBuffer) {
  const opts = {
    wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
    bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
    vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
    // Raw image: decompressing zstd chunks needs a Web Worker, which Node
    // lacks. The disk backend does not affect whether guest writes are
    // captured - they land in the IDE write-back cache either way.
    hda: {
      url: path.join(ROOT, "images/debian.img"),
      async: true,
      size: 5 * 1024 * 1024 * 1024,
    },
    memory_size: 256 * 1024 * 1024,
    autostart: true,
  };
  if (initialStateBuffer) {
    opts.initial_state = { buffer: initialStateBuffer };
  } else {
    opts.bzimage = { url: path.join(ROOT, "images/debian-bzImage") };
    opts.initrd = { url: path.join(ROOT, "images/debian-initrd") };
    opts.cmdline = "root=/dev/sda rw console=ttyS0";
  }
  return new V86(opts);
}

/**
 * Run a script in the guest and resolve when its marker appears as a line of
 * its own. Counting occurrences is not reliable: bash echoes the command line,
 * and can reprint it after a redraw, so the marker shows up in the echo before
 * the shell has run anything. Only real output is a bare line.
 */
function runScript(emu, script, marker, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      reject(new Error("timeout waiting for " + marker + "\n" + text.slice(-400)));
    }, timeoutMs);
    const listener = byte => {
      text += String.fromCharCode(byte);
      const sawMarker = text.replace(/\r/g, "").split("\n").some(l => l.trim() === marker);
      if (sawMarker) {
        clearTimeout(timer);
        emu.remove_listener("serial0-output-byte", listener);
        resolve(text);
      }
    };
    emu.add_listener("serial0-output-byte", listener);
    emu.serial0_send(script + "; echo " + marker + "\n");
  });
}

function booted(emu, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("boot timeout")), timeoutMs);
    const listener = byte => {
      text += String.fromCharCode(byte);
      if (/root@golinux:~#/.test(text)) {
        clearTimeout(timer);
        emu.remove_listener("serial0-output-byte", listener);
        resolve();
      }
    };
    emu.add_listener("serial0-output-byte", listener);
    // A restored guest does not replay its old output; nudge the prompt.
    emu.add_listener("emulator-loaded", () => emu.serial0_send("\n"));
  });
}

(async () => {
  // ---- 1. boot from the shipped snapshot -----------------------------------
  const snap = fs.readFileSync(SNAPSHOT);
  const emu = makeEmulator(
    snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength));
  await booted(emu);
  console.log("[1] booted from shipped snapshot");

  // ---- 2. create files and compile ----------------------------------------
  const marker = "CREATED_OK";
  const script = [
    "mkdir -p /root/project",
    "printf 'hello from golinux\\n' > /root/project/notes.txt",
    "printf 'int main(){return 42;}' > /root/project/t.c",
    "gcc -O0 -o /root/project/t /root/project/t.c",
    "/root/project/t",
    "echo COMPILE_EXIT=$?",
    "sync",
  ].join("; ");
  const out = await runScript(emu, script, marker);
  console.log("[2] raw output of create step (last 400 chars):");
  console.log(JSON.stringify(out.slice(-400)));

  // ---- 3. save the state ---------------------------------------------------
  const state = await emu.save_state();
  const rawBuf = Buffer.from(state);
  fs.writeFileSync(OUT_RAW, rawBuf);
  console.log(`[3] save_state(): ${(rawBuf.length / 1048576).toFixed(1)} MiB raw`);

  execFileSync("zstd", ["-19", "-T0", "-f", OUT_RAW, "-o", OUT_ZST], { stdio: "ignore" });
  execFileSync("gzip", ["-9", "-c", OUT_RAW], {
    stdio: ["ignore", fs.openSync(OUT_GZ, "w"), "ignore"],
  });
  const zst = fs.statSync(OUT_ZST).size;
  const gz = fs.statSync(OUT_GZ).size;
  console.log(`    zstd -19: ${(zst / 1048576).toFixed(2)} MiB`);
  console.log(`    gzip -9:  ${(gz / 1048576).toFixed(2)} MiB`);

  const shipped = fs.statSync(SNAPSHOT).size;
  console.log(`    shipped snapshot for comparison: ${(shipped / 1048576).toFixed(2)} MiB`);

  emu.stop();

  // ---- 4. restore into a NEW instance and verify --------------------------
  const restoreBuf = rawBuf.buffer.slice(
    rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
  const emu2 = makeEmulator(restoreBuf);
  let bootText = "";
  emu2.add_listener("serial0-output-byte", b => { bootText += String.fromCharCode(b); });
  emu2.add_listener("emulator-loaded", () => console.log("[4a] emulator-loaded fired"));
  emu2.add_listener("emulator-started", () => console.log("[4b] emulator-started fired"));
  try {
    await booted(emu2);
    console.log("[4] restored saved state into a fresh instance");
  } catch (e) {
    console.log("[4] RESTORE FAILED:", e.message);
    console.log("     serial so far:", JSON.stringify(bootText.slice(-300)));
    process.exit(1);
  }

  const check = await runScript(emu2, [
    "ls -1 /root/project",
    "cat /root/project/notes.txt",
    "/root/project/t",
    "echo BIN_EXIT=$?",
    // Marker is appended by runScript, and must not appear in the script text,
    // or it matches the echoed command before the shell has run anything.
  ].join("; "), "CHECK_OK");

  const lines = check.replace(/\r/g, "").split("\n");
  const hasNotes = lines.some(l => l.includes("hello from golinux"));
  const hasBinary = lines.some(l => l.includes("BIN_EXIT=42"));
  const listing = lines.filter(l => /notes\.txt|^t$|^t\.c$/.test(l.trim()));

  console.log("[5] verification after restore:");
  console.log("    listing:", JSON.stringify(listing));
  console.log("    notes.txt content present:", hasNotes);
  console.log("    compiled binary ran (exit 42):", hasBinary);
  console.log("");
  console.log(hasNotes && hasBinary ? "RESULT: user state DOES capture file changes"
                                    : "RESULT: FAILED to capture changes");
  process.exit(hasNotes && hasBinary ? 0 : 1);
})().catch(e => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
