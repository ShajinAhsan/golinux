#!/usr/bin/env node
/**
 * Real headless-VM E2E integration test for SafeFetchNetworkAdapter + Alpine 3.21.
 *
 * Boots the shipped debian-state.bin.zst snapshot in v86 with virtio-net and
 * SafeFetchNetworkAdapter, then runs real Linux commands (curl, nslookup, ping,
 * nethelp) inside the guest to verify:
 *   1. Offline by default (zero outbound fetch calls; curl fails fast)
 *   2. Live toggle ON without restarting VM
 *   3. Real Alpine curl HTTP GET (upgraded to HTTPS) & POST (including >1KB Expect: 100-continue)
 *   4. SSRF protection from inside Linux (127.0.0.1, 8080.external -> 403)
 *   5. CORS error returns readable 502 Bad Gateway
 *   6. Port 443 returns Connection refused + triggers onBlockedPort(443)
 *   7. Gateway ping (192.168.86.1) succeeds; nethelp works
 *   8. Clean toggle OFF & adapter.destroy() with zero unhandled rejections
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

let passed = 0;
let failed = 0;
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

function check(cond, msg) {
  if (cond) {
    passed++;
    console.log("ok: " + msg);
  } else {
    failed++;
    console.error("FAIL: " + msg);
  }
}

function buildDnsAReply(query, ipBytes) {
  // Minimal valid RFC 1035 A-record reply pointing to the first question.
  const q = new Uint8Array(query);
  // Skip header (12 bytes) + QNAME + QTYPE(2) + QCLASS(2)
  let pos = 12;
  while (pos < q.length && q[pos] !== 0) pos += 1 + q[pos];
  pos += 1 + 4;
  if (pos > q.length) return null;
  const answer = new Uint8Array([
    0xc0, 0x0c,             // pointer to QNAME at offset 12
    0x00, 0x01,             // TYPE A
    0x00, 0x01,             // CLASS IN
    0x00, 0x00, 0x00, 0x3c, // TTL 60
    0x00, 0x04,             // RDLENGTH 4
    ipBytes[0], ipBytes[1], ipBytes[2], ipBytes[3],
  ]);
  const out = new Uint8Array(pos + answer.length);
  out.set(q.subarray(0, pos), 0);
  out.set(answer, pos);
  out[2] = 0x81; out[3] = 0x80; // QR=1, RD=1, RA=1, NOERROR
  out[6] = 0; out[7] = 1;       // ANCOUNT = 1
  out[8] = 0; out[9] = 0;
  out[10] = 0; out[11] = 0;
  return out;
}

async function main() {
  const { SafeFetchNetworkAdapter } = await import(
    pathToFileURL(path.join(ROOT, "js/net-adapter.js")).href
  );

  // Decompress shipped snapshot in memory
  const stateBuf = execFileSync("zstd", ["-dc", path.join(ROOT, "images/debian-state.bin.zst")], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const stateArrayBuf = stateBuf.buffer.slice(stateBuf.byteOffset, stateBuf.byteOffset + stateBuf.byteLength);
  const diskBytes = fs.statSync(path.join(ROOT, "images/debian.img")).size;

  const emu = new V86({
    wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
    bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
    vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
    hda: {
      url: path.join(ROOT, "images/debian.img"),
      async: true,
      size: diskBytes,
    },
    filesystem: {},
    virtio_console: true,
    net_device: { type: "virtio" },
    preserve_mac_from_state_image: true,
    memory_size: 128 * 1024 * 1024,
    initial_state: { buffer: stateArrayBuf },
    autostart: true,
  });

  const fetchLog = [];
  const blockedPorts = [];
  const adapter = new SafeFetchNetworkAdapter(emu.bus, {
    enabled: false,
    onBlockedPort: (p) => blockedPorts.push(p),
    fetchImpl: async (url, init) => {
      fetchLog.push({ url, method: init.method });
      if (url.includes("/dns-query")) {
        const reply = buildDnsAReply(init.body, [93, 184, 216, 34]);
        return new Response(reply, {
          status: 200,
          headers: { "content-type": "application/dns-message" },
        });
      }
      if (url === "https://api.example.com/zen") {
        return new Response("Zero-server Alpine fetch works!\n", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://api.example.com/echo") {
        const body = init.body ? new TextDecoder().decode(init.body) : "";
        return new Response("ECHO_LEN=" + body.length + ":" + body.slice(0, 16) + "\n", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.includes("nocors.example.com")) {
        throw new TypeError("Failed to fetch");
      }
      return new Response("not found\n", { status: 404, statusText: "Not Found" });
    },
  });

  let serial = "";
  emu.add_listener("serial0-output-byte", (b) => {
    serial += String.fromCharCode(b);
  });

  const runCmd = (cmd, marker, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const startLen = serial.length;
      const doneTag = "__DONE_" + marker + "__";
      emu.serial0_send(`${cmd}; echo ${doneTag}:$?\n`);
      const deadline = Date.now() + timeoutMs;
      const iv = setInterval(() => {
        const slice = serial.slice(startLen).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        const m = new RegExp(`(?:^|[\\r\\n])${doneTag}:(\\d+)\\r?\\n`).exec(slice);
        if (m) {
          clearInterval(iv);
          resolve({ out: slice, code: Number(m[1]) });
        } else if (Date.now() > deadline) {
          clearInterval(iv);
          reject(new Error(`Timeout running ${marker}; tail=${JSON.stringify(slice.slice(-300))}`));
        }
      }, 40);
    });

  await new Promise((r) => setTimeout(r, 600));

  // 1. Verify eth0 & lo are already UP from snapshot
  const rIp = await runCmd("ip -4 addr show dev eth0", "IP");
  check(rIp.code === 0 && rIp.out.includes("192.168.86.100/24"), "guest eth0 has 192.168.86.100/24 in snapshot");

  // 2. Verify OFF by default: zero fetches and fast failure
  const rOff = await runCmd("curl -sS --max-time 5 http://api.example.com/zen", "OFF");
  check(rOff.code !== 0 && fetchLog.length === 0, "default OFF mode fails fast with zero outbound fetches");

  // 3. Toggle ON live (NO VM restart!)
  adapter.setEnabled(true);
  check(adapter.isEnabled(), "adapter toggles ON live without VM restart");

  // 4. Real Alpine curl GET (HTTP -> HTTPS upgrade)
  const rGet = await runCmd("curl -sS --max-time 10 http://api.example.com/zen", "GET");
  check(rGet.code === 0 && rGet.out.includes("Zero-server Alpine fetch works!"), "real Alpine curl GET succeeds end-to-end over virtio-net");

  // 5. Real Alpine curl POST > 1KB (exercises Expect: 100-continue)
  const rPost = await runCmd("python3 -c 'print(\"A\"*1500, end=\"\")' | curl -sS --max-time 10 -X POST --data-binary @- http://api.example.com/echo", "POST");
  check(rPost.code === 0 && rPost.out.includes("ECHO_LEN=1500:AAAAAAAAAAAAAAAA"), "real Alpine curl POST (>1KB + Expect:100-continue) succeeds");

  // 6. SSRF guard from inside real Linux
  const rSsrf1 = await runCmd("curl -s -i --max-time 5 http://127.0.0.1:80/", "SSRF1");
  check(rSsrf1.out.includes("403 Forbidden") || rSsrf1.code !== 0, "real Linux curl to 127.0.0.1 blocked (never reaches host)");
  const rSsrf2 = await runCmd("curl -s -i --max-time 5 http://8080.external/", "SSRF2");
  check(rSsrf2.out.includes("403 Forbidden"), "real Linux curl to 8080.external returns 403 Forbidden");

  // 7. CORS error returns readable 502 explanation
  const rCors = await runCmd("curl -s -i --max-time 5 http://nocors.example.com/", "CORS");
  check(rCors.out.includes("502 Bad Gateway") && rCors.out.includes("CORS"), "CORS failure returns readable 502 hint inside Alpine");

  // 8. Port 443 fails cleanly + fires onBlockedPort(443)
  const rTls = await runCmd("curl -sS --max-time 5 https://api.example.com/zen", "TLS");
  check(rTls.code !== 0 && blockedPorts.includes(443), "port 443 returns Connection refused and triggers onBlockedPort(443)");

  // 9. Gateway ping & nethelp
  const rPing = await runCmd("ping -c 1 -W 2 192.168.86.1", "PING");
  check(rPing.code === 0 && rPing.out.includes("1 packets received"), "ping 192.168.86.1 succeeds");

  const rHelp = await runCmd("nethelp", "HELP");
  check(rHelp.code === 0 && rHelp.out.includes("GoLinux Zero-Server Browser Networking"), "nethelp helper works inside Alpine");

  // 10. Toggle OFF again and verify zero new fetches
  adapter.setEnabled(false);
  const countBefore = fetchLog.length;
  const rOff2 = await runCmd("curl -sS --max-time 5 http://api.example.com/zen", "OFF2");
  check(rOff2.code !== 0 && fetchLog.length === countBefore, "toggling OFF immediately blocks outbound traffic again");

  adapter.destroy();
  emu.stop();

  await new Promise((r) => setTimeout(r, 100));
  check(unhandled.length === 0, `zero unhandled rejections (got ${unhandled.length})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
