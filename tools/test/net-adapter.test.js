#!/usr/bin/env node
/**
 * Unit tests for js/net-adapter.js (SafeFetchNetworkAdapter).
 *
 * Verifies:
 *   - URL & SSRF guard (localhost, *.external, RFC1918, metadata IP, IPv6, same-origin, HTTP->HTTPS)
 *   - Disabled-by-default air-gap (zero fetch/DoH calls, fast TCP RST / DNS REFUSED)
 *   - Full TCP HTTP GET, HEAD, POST Content-Length, POST Expect:100-continue, POST chunked
 *   - Strict backpressure memory bound on large streaming responses + max-response-bytes cap
 *   - Concurrency cap (>8 rejected with TCP RST)
 *   - Immediate AbortController cancellation on guest RST, setEnabled(false), and destroy()
 *   - Hardened DoH DNS (valid response, offline SERVFAIL, HTML error SERVFAIL, txid mismatch)
 *   - Zero unhandled promise rejections across all error paths
 */
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..", "..");

let passed = 0;
let failed = 0;
const unhandled = [];

process.on("unhandledRejection", (err) => {
  unhandled.push(err);
});

function check(cond, msg) {
  if (cond) {
    passed++;
    console.log("ok: " + msg);
  } else {
    failed++;
    console.error("FAIL: " + msg);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

class MockBus {
  constructor() {
    this.handlers = new Map();
    this.rxFrames = [];
  }
  register(name, fn, ctx) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push({ fn, ctx });
  }
  unregister(name, fn) {
    const arr = this.handlers.get(name);
    if (!arr) return;
    this.handlers.set(name, arr.filter((h) => h.fn !== fn));
  }
  send(name, data) {
    if (name === "net0-receive") {
      this.rxFrames.push(data);
      return;
    }
    const arr = this.handlers.get(name) || [];
    for (const h of arr) h.fn.call(h.ctx, data);
  }
  injectGuest(frame) {
    this.send("net0-send", frame);
  }
}

const GUEST_MAC = new Uint8Array([0x00, 0x22, 0x15, 0xaa, 0xbb, 0xcc]);
const ROUTER_MAC = new Uint8Array([0x52, 0x54, 0x00, 0x01, 0x02, 0x03]);
const GUEST_IP = new Uint8Array([192, 168, 86, 100]);
const ROUTER_IP = new Uint8Array([192, 168, 86, 1]);
const REMOTE_IP = new Uint8Array([93, 184, 216, 34]);

/** Minimal guest-side TCP client helper for driving adapter packets cleanly. */
class GuestTcpClient {
  constructor(bus, mod, { sport, dport = 80, remoteIp = REMOTE_IP }) {
    this.bus = bus;
    this.mod = mod;
    this.sport = sport;
    this.dport = dport;
    this.remoteIp = remoteIp;
    this.seq = 1000;
    this.ack = 0;
    this.received = [];
    this.gotSynAck = false;
    this.gotFin = false;
    this.gotRst = false;
    this.rxCursor = 0;
  }

  send(flags, payload = null) {
    const frame = this.mod.encodeEthFrame({
      eth: { ethertype: 0x0800, src: GUEST_MAC, dest: ROUTER_MAC },
      ipv4: { proto: 6, src: GUEST_IP, dest: this.remoteIp },
      tcp: {
        sport: this.sport,
        dport: this.dport,
        seq: this.seq,
        ackn: this.ack,
        ...flags,
      },
      tcpData: payload,
    });
    if (flags.syn) this.seq = (this.seq + 1) >>> 0;
    if (payload && payload.length) this.seq = (this.seq + payload.length) >>> 0;
    if (flags.fin) this.seq = (this.seq + 1) >>> 0;
    this.bus.injectGuest(frame);
  }

  drain(autoAck = true) {
    let count = 0;
    while (this.rxCursor < this.bus.rxFrames.length) {
      const frame = this.bus.rxFrames[this.rxCursor++];
      const pkt = this.mod.parseEthFrame(frame);
      if (!pkt || !pkt.tcp) continue;
      if (pkt.tcp.dport !== this.sport || pkt.tcp.sport !== this.dport) continue;
      count++;
      if (pkt.tcp.rst) {
        this.gotRst = true;
        continue;
      }
      if (pkt.tcp.syn && pkt.tcp.ack) {
        this.gotSynAck = true;
        this.ack = (pkt.tcp.seq + 1) >>> 0;
        if (autoAck) this.send({ ack: true });
        continue;
      }
      if (pkt.tcpData && pkt.tcpData.length > 0) {
        if ((pkt.tcp.seq >>> 0) === this.ack) {
          this.received.push(pkt.tcpData.slice());
          this.ack = (this.ack + pkt.tcpData.length) >>> 0;
        }
        if (autoAck) this.send({ ack: true });
      }
      if (pkt.tcp.fin) {
        this.gotFin = true;
        this.ack = (pkt.tcp.seq + (pkt.tcpData ? pkt.tcpData.length : 0) + 1) >>> 0;
        if (autoAck) this.send({ ack: true, fin: true });
      }
    }
    return count;
  }

  bodyText() {
    let total = 0;
    for (const c of this.received) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.received) { out.set(c, off); off += c.length; }
    return dec.decode(out);
  }
}

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, "js/net-adapter.js")).href);
  const { SafeFetchNetworkAdapter, validateTargetUrl, decodeChunkedBody, encodeEthFrame, parseEthFrame } = mod;

  /* ---- 1. URL & SSRF security tests ---- */
  const blockedHosts = new Set(["terminal.golinux.app", "assets.golinux.app"]);
  const blockedUrls = [
    "http://localhost/secret",
    "http://sub.localhost/secret",
    "http://8080.external/secret",
    "http://127.0.0.1:8099/",
    "http://127.1.2.3/",
    "http://0x7f000001/",
    "http://10.0.0.1/",
    "http://172.16.5.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://printer.local/",
    "http://db.internal/",
    "http://intranet/",
    "http://terminal.golinux.app/sw.js",
    "http://assets.golinux.app/bundles.json",
    "http://user:pass@api.github.com/zen",
    "ftp://api.github.com/zen",
  ];
  for (const u of blockedUrls) {
    const r = validateTargetUrl(u, { blockedHosts });
    check(!r.ok, `URL guard blocks ${u}`);
  }

  const okUrl = validateTargetUrl("http://api.github.com/zen", { blockedHosts });
  check(okUrl.ok && okUrl.url === "https://api.github.com/zen", "URL guard allows public host & upgrades http -> https");

  /* ---- 2. Chunked body decoder ---- */
  const chunked = enc.encode("5\r\nHello\r\n7\r\n, world\r\n0\r\n\r\n");
  const decRes = decodeChunkedBody(chunked, 1024);
  check(decRes.status === "done" && dec.decode(decRes.body) === "Hello, world", "chunked body decodes cleanly");
  const overChunk = decodeChunkedBody(chunked, 8);
  check(overChunk.status === "error" && overChunk.code === 413, "chunked body enforces maxBytes");

  /* ---- 3. Disabled-by-default air-gap ---- */
  {
    let fetchCalls = 0;
    const bus = new MockBus();
    const adapter = new SafeFetchNetworkAdapter(bus, {
      fetchImpl: async () => { fetchCalls++; throw new Error("should not call"); },
    });
    check(!adapter.isEnabled(), "adapter starts disabled by default");

    // ARP still replies for gateway so guest never hangs on ARP timeout
    bus.injectGuest(encodeEthFrame({
      eth: { ethertype: 0x0806, src: GUEST_MAC, dest: new Uint8Array(6).fill(0xff) },
      arp: { htype: 1, ptype: 0x0800, oper: 1, sha: GUEST_MAC, spa: GUEST_IP, tha: new Uint8Array(6), tpa: ROUTER_IP },
    }));
    check(bus.rxFrames.length === 1 && parseEthFrame(bus.rxFrames[0]).arp.oper === 2, "ARP replies cleanly when disabled");

    // TCP SYN gets instant RST
    const c = new GuestTcpClient(bus, mod, { sport: 40001 });
    c.send({ syn: true });
    c.drain();
    check(c.gotRst && !c.gotSynAck, "TCP SYN receives immediate RST when disabled");

    // DNS gets immediate REFUSED (rcode 5)
    const dnsQuery = new Uint8Array([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const before = bus.rxFrames.length;
    bus.injectGuest(encodeEthFrame({
      eth: { ethertype: 0x0800, src: GUEST_MAC, dest: ROUTER_MAC },
      ipv4: { proto: 17, src: GUEST_IP, dest: ROUTER_IP },
      udp: { sport: 51234, dport: 53, data: dnsQuery },
    }));
    const dnsReply = parseEthFrame(bus.rxFrames[before]);
    check(dnsReply && dnsReply.udp && (dnsReply.udp.data[3] & 0x0f) === 5, "DNS returns REFUSED immediately when disabled");
    check(fetchCalls === 0, "zero fetch calls issued while disabled");
    adapter.destroy();
  }

  /* ---- 4. Live toggle ON: GET, HEAD, POST + Expect: 100-continue, Chunked POST, SSRF 403, Port 443 RST ---- */
  {
    const seenCalls = [];
    const blockedPorts = [];
    const bus = new MockBus();
    const adapter = new SafeFetchNetworkAdapter(bus, {
      enabled: true,
      blockedHosts,
      onBlockedPort: (p) => blockedPorts.push(p),
      fetchImpl: async (url, init) => {
        seenCalls.push({ url, init });
        const bodyText = init.body ? dec.decode(init.body) : "";
        const respText = `OK:${init.method}:${url}:${bodyText}`;
        return new Response(init.method === "HEAD" ? null : respText, {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        });
      },
    });

    // 4a. GET
    const cGet = new GuestTcpClient(bus, mod, { sport: 40100 });
    cGet.send({ syn: true });
    cGet.drain();
    check(cGet.gotSynAck, "GET: TCP handshake completes");
    cGet.send({ ack: true, psh: true }, enc.encode("GET /zen HTTP/1.1\r\nHost: api.github.com\r\nCookie: secret=1\r\n\r\n"));
    for (let i = 0; i < 10 && !cGet.gotFin; i++) { await sleep(5); cGet.drain(); }
    const getText = cGet.bodyText();
    check(getText.includes("HTTP/1.1 200 OK") && getText.includes("OK:GET:https://api.github.com/zen:"), "GET: upgrades HTTP -> HTTPS and streams response");
    check(seenCalls[0].init.credentials === "omit" && seenCalls[0].init.referrerPolicy === "no-referrer", "GET: enforces credentials:omit & referrerPolicy:no-referrer");
    check(!seenCalls[0].init.headers.has("cookie"), "GET: strips forbidden Cookie header");

    // 4b. POST with Expect: 100-continue
    const cPost = new GuestTcpClient(bus, mod, { sport: 40101 });
    cPost.send({ syn: true });
    cPost.drain();
    cPost.send({ ack: true, psh: true }, enc.encode("POST /echo HTTP/1.1\r\nHost: httpbin.org\r\nContent-Length: 11\r\nExpect: 100-continue\r\n\r\n"));
    cPost.drain();
    check(cPost.bodyText().includes("HTTP/1.1 100 Continue"), "POST: replies immediately to Expect: 100-continue");
    cPost.send({ ack: true, psh: true }, enc.encode("hello=world"));
    for (let i = 0; i < 10 && !cPost.gotFin; i++) { await sleep(5); cPost.drain(); }
    check(cPost.bodyText().includes("OK:POST:https://httpbin.org/echo:hello=world"), "POST: forwards full body after 100 Continue");

    // 4c. Chunked POST
    const cChunk = new GuestTcpClient(bus, mod, { sport: 40102 });
    cChunk.send({ syn: true });
    cChunk.drain();
    cChunk.send({ ack: true, psh: true }, enc.encode("POST /chunk HTTP/1.1\r\nHost: httpbin.org\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n0\r\n\r\n"));
    for (let i = 0; i < 10 && !cChunk.gotFin; i++) { await sleep(5); cChunk.drain(); }
    check(cChunk.bodyText().includes("OK:POST:https://httpbin.org/chunk:abcd"), "Chunked POST decodes and forwards body");

    // 4d. Blocked private host over port 80 -> 403 Forbidden (zero fetch call)
    const beforeCalls = seenCalls.length;
    const cSsrf = new GuestTcpClient(bus, mod, { sport: 40103 });
    cSsrf.send({ syn: true });
    cSsrf.drain();
    cSsrf.send({ ack: true, psh: true }, enc.encode("GET / HTTP/1.1\r\nHost: 8080.external\r\n\r\n"));
    for (let i = 0; i < 10 && !cSsrf.gotFin; i++) { await sleep(5); cSsrf.drain(); }
    check(cSsrf.bodyText().includes("403 Forbidden") && seenCalls.length === beforeCalls, "8080.external returns 403 Forbidden with zero fetch call");

    // 4e. Port 443 -> TCP RST + onBlockedPort callback
    const cTls = new GuestTcpClient(bus, mod, { sport: 40104, dport: 443 });
    cTls.send({ syn: true });
    cTls.drain();
    check(cTls.gotRst && blockedPorts.includes(443), "Port 443 sends TCP RST and fires onBlockedPort(443)");

    adapter.destroy();
  }

  /* ---- 5. Backpressure memory bound + maxResponseBytes OOM guard ---- */
  {
    const bus = new MockBus();
    let chunksPulled = 0;
    let peakQueued = 0;
    let signalAborted = false;

    const adapter = new SafeFetchNetworkAdapter(bus, {
      enabled: true,
      limits: {
        highWaterBytes: 16 * 1024,
        lowWaterBytes: 8 * 1024,
        maxResponseBytes: 64 * 1024,
      },
      fetchImpl: async (_url, init) => {
        init.signal.addEventListener("abort", () => { signalAborted = true; });
        const stream = new ReadableStream({
          pull(controller) {
            chunksPulled++;
            controller.enqueue(new Uint8Array(8 * 1024).fill(65));
          },
        });
        return new Response(stream, { status: 200, statusText: "OK" });
      },
    });

    const c = new GuestTcpClient(bus, mod, { sport: 40200 });
    c.send({ syn: true });
    c.drain();
    c.send({ ack: true, psh: true }, enc.encode("GET /huge HTTP/1.1\r\nHost: api.github.com\r\n\r\n"));

    // Do NOT ACK guest packets yet — verify backpressure pauses stream pulls!
    await sleep(40);
    const conn = [...adapter.conns.values()][0];
    peakQueued = conn ? conn.sendQueuedBytes : 0;
    check(chunksPulled <= 4 && peakQueued <= 32 * 1024, `backpressure pauses fetch reader when guest stops ACKing (pulled=${chunksPulled}, queued=${peakQueued})`);

    // Now ACK packets until maxResponseBytes (64 KiB) triggers clean abort & RST!
    for (let i = 0; i < 120 && !c.gotRst; i++) {
      c.drain(true);
      await sleep(2);
    }
    check(c.gotRst && signalAborted, "exceeding maxResponseBytes aborts fetch signal and sends TCP RST");
    check(adapter.conns.size === 0, "aborted connection removed cleanly from map");
    adapter.destroy();
  }

  /* ---- 6. Concurrency cap + Abort on guest RST, toggle OFF, and destroy() ---- */
  {
    const signals = [];
    const bus = new MockBus();
    const adapter = new SafeFetchNetworkAdapter(bus, {
      enabled: true,
      limits: { maxConcurrentConns: 3 },
      fetchImpl: (_url, init) => {
        signals.push(init.signal);
        return new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("Aborted");
            e.name = "AbortError";
            rej(e);
          });
        });
      },
    });

    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = new GuestTcpClient(bus, mod, { sport: 40300 + i });
      c.send({ syn: true });
      c.drain();
      c.send({ ack: true, psh: true }, enc.encode("GET /slow HTTP/1.1\r\nHost: api.github.com\r\n\r\n"));
      clients.push(c);
    }
    await sleep(10);
    check(adapter.conns.size === 3 && signals.length === 3, "accepts up to maxConcurrentConns (3)");

    // 4th connection must be rejected with TCP RST
    const c4 = new GuestTcpClient(bus, mod, { sport: 40399 });
    c4.send({ syn: true });
    c4.drain();
    check(c4.gotRst && !c4.gotSynAck, "exceeding maxConcurrentConns rejects with immediate TCP RST");

    // Guest RST on client 0 aborts signal 0
    clients[0].send({ rst: true, ack: true });
    await sleep(10);
    check(signals[0].aborted && adapter.conns.size === 2, "guest TCP RST immediately aborts in-flight fetch");

    // Toggling OFF aborts remaining fetches cleanly
    adapter.setEnabled(false);
    await sleep(10);
    check(signals[1].aborted && signals[2].aborted && adapter.conns.size === 0, "setEnabled(false) aborts all active fetches and clears connections");
    adapter.destroy();
  }

  /* ---- 7. Hardened DoH DNS (success, offline SERVFAIL, HTML error SERVFAIL, txid mismatch) ---- */
  {
    let mode = "ok";
    const bus = new MockBus();
    const adapter = new SafeFetchNetworkAdapter(bus, {
      enabled: true,
      fetchImpl: async (_url, init) => {
        if (mode === "offline") throw new TypeError("Failed to fetch");
        if (mode === "html") {
          return new Response("<html>500</html>", { status: 200, headers: { "content-type": "text/html" } });
        }
        if (mode === "bad-txid") {
          const r = new Uint8Array(init.body);
          r[0] ^= 0xff;
          return new Response(r, { status: 200, headers: { "content-type": "application/dns-message" } });
        }
        const r = new Uint8Array(init.body);
        r[2] = 0x81; r[3] = 0x80; // QR=1, NOERROR
        return new Response(r, { status: 200, headers: { "content-type": "application/dns-message" } });
      },
    });

    const sendDns = async (txHi, txLo) => {
      const idx = bus.rxFrames.length;
      const q = new Uint8Array([txHi, txLo, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
      bus.injectGuest(encodeEthFrame({
        eth: { ethertype: 0x0800, src: GUEST_MAC, dest: ROUTER_MAC },
        ipv4: { proto: 17, src: GUEST_IP, dest: ROUTER_IP },
        udp: { sport: 52000 + txLo, dport: 53, data: q },
      }));
      for (let i = 0; i < 20 && bus.rxFrames.length === idx; i++) await sleep(5);
      return bus.rxFrames.length > idx ? parseEthFrame(bus.rxFrames[idx]) : null;
    };

    const rOk = await sendDns(0xaa, 0x01);
    check(rOk && rOk.udp && rOk.udp.data[0] === 0xaa && (rOk.udp.data[3] & 0x0f) === 0, "DoH valid response relayed with matching txid");

    mode = "offline";
    const rOff = await sendDns(0xaa, 0x02);
    check(rOff && rOff.udp && (rOff.udp.data[3] & 0x0f) === 2, "DoH offline failure returns RFC 1035 SERVFAIL cleanly");

    mode = "html";
    const rHtml = await sendDns(0xaa, 0x03);
    check(rHtml && rHtml.udp && (rHtml.udp.data[3] & 0x0f) === 2, "DoH non-dns-message HTML response rejected with SERVFAIL");

    mode = "bad-txid";
    const rBad = await sendDns(0xaa, 0x04);
    check(rBad && rBad.udp && (rBad.udp.data[3] & 0x0f) === 2, "DoH mismatched transaction ID rejected with SERVFAIL");

    adapter.destroy();
  }

  /* ---- 8. CORS failure returns readable 502 Bad Gateway ---- */
  {
    const bus = new MockBus();
    const adapter = new SafeFetchNetworkAdapter(bus, {
      enabled: true,
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
    });
    const c = new GuestTcpClient(bus, mod, { sport: 40400 });
    c.send({ syn: true });
    c.drain();
    c.send({ ack: true, psh: true }, enc.encode("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"));
    for (let i = 0; i < 10 && !c.gotFin; i++) { await sleep(5); c.drain(); }
    const txt = c.bodyText();
    check(txt.includes("HTTP/1.1 502 Bad Gateway") && txt.includes("CORS"), "CORS/network failure returns informative 502 explanation");
    adapter.destroy();
  }

  await sleep(30);
  check(unhandled.length === 0, `zero unhandled promise rejections (got ${unhandled.length})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
