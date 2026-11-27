/* GoLinux SafeFetchNetworkAdapter — hardened, zero-server browser networking.
 *
 * Attaches directly to v86's existing bus ("net0-send" / "net0-receive" / "net0-mac")
 * without modifying vendored assets/v86/libv86.js.
 *
 * Security & stability invariants:
 *   - Disabled by default (opt-in live toggle via setEnabled(); zero requests when OFF).
 *   - Blocks localhost, *.external, *.local, *.internal, private/loopback/link-local/
 *     metadata IPv4 & IPv6 literals, and same-origin hosts.
 *   - Always fetches with credentials:"omit", referrerPolicy:"no-referrer", mode:"cors".
 *   - Strict backpressure on ReadableStreamDefaultReader (<= 64 KiB queued per conn)
 *     and hard response/request/concurrency/timeout caps so mobile tabs never OOM.
 *   - Every fetch/DoH call has an AbortController aborted immediately on guest RST/FIN,
 *     toggle OFF, or destroy() (VM restart), with zero unhandled promise rejections.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_LIMITS = Object.freeze({
  mtu: 1500,
  mss: 1460,
  highWaterBytes: 64 * 1024,
  lowWaterBytes: 32 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxRequestBodyBytes: 4 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxConcurrentConns: 8,
  maxConcurrentDns: 4,
  requestTimeoutMs: 30000,
  dohTimeoutMs: 5000,
  idleConnTimeoutMs: 30000,
  maxDnsUdpBytes: 512,
  retransmitBaseMs: 250,
  maxRetransmits: 5,
});

const DEFAULT_ROUTER_MAC = new Uint8Array([0x52, 0x54, 0x00, 0x01, 0x02, 0x03]);
const DEFAULT_ROUTER_IP = new Uint8Array([192, 168, 86, 1]);
const DEFAULT_VM_IP = new Uint8Array([192, 168, 86, 100]);
const DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query";

const FORBIDDEN_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "content-length",
  "transfer-encoding",
  "expect",
  "upgrade",
  "te",
  "trailer",
  "cookie",
  "origin",
  "referer",
  "user-agent",
  "accept-encoding",
  "dnt",
]);

const STRIP_RESP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "connection",
  "proxy-connection",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".external",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".corp",
  ".localdomain",
];

/* ---------- Pure Security & HTTP Helpers (unit-testable) ---------- */

function parseIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return parts;
}

function isBlockedIpv4(p) {
  const [a, b] = p;
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local/metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 0 && p[2] === 0) return true;// 192.0.0.0/24
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true;// 198.18.0.0/15
  if (a >= 224) return true;                          // multicast & reserved
  return false;
}

function isBlockedIpv6(host) {
  const raw = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase();
  if (!raw.includes(":")) return false;
  if (raw === "::" || raw === "::1") return true;
  if (raw.startsWith("fc") || raw.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(raw)) return true;                        // link-local fe80::/10
  if (raw.startsWith("ff")) return true;                         // multicast
  if (raw.startsWith("::ffff:") || raw.startsWith("::0:") || raw.startsWith("64:ff9b:") || raw.startsWith("2002:")) return true;
  if (raw.startsWith("0:0:0:0:0:0:0:0") || raw.startsWith("0:0:0:0:0:0:0:1")) return true;
  return false;
}

/**
 * Validate and normalize an outbound HTTP(S) URL requested by the guest.
 * Returns { ok: true, url: string } or { ok: false, status: number, reason: string }.
 */
export function validateTargetUrl(rawUrl, opts = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return { ok: false, status: 400, reason: "Malformed target URL." };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, status: 403, reason: "Only http/https URLs are permitted." };
  }
  if (u.username || u.password) {
    return { ok: false, status: 403, reason: "Embedded URL credentials are not permitted." };
  }

  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) {
    return { ok: false, status: 400, reason: "Missing target hostname." };
  }

  // Test-only explicit allowlist (never set in production).
  const allowedTestHosts = opts.allowedTestHosts;
  if (allowedTestHosts && allowedTestHosts.has(host)) {
    return { ok: true, url: u.href };
  }

  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, status: 403, reason: `Blocked local/private hostname: ${host}` };
  }

  if (opts.blockedHosts && opts.blockedHosts.has(host)) {
    return { ok: false, status: 403, reason: `Blocked same-origin/app hostname: ${host}` };
  }

  if (host.includes(":")) {
    if (isBlockedIpv6(host)) {
      return { ok: false, status: 403, reason: `Blocked private/local IPv6 address: ${host}` };
    }
  } else {
    const ipv4 = parseIpv4(host);
    if (ipv4) {
      if (isBlockedIpv4(ipv4)) {
        return { ok: false, status: 403, reason: `Blocked private/local IP address: ${host}` };
      }
    } else if (!host.includes(".")) {
      return { ok: false, status: 403, reason: `Blocked unqualified hostname: ${host}` };
    }
  }

  // Upgrade guest plaintext http:// to https:// so HTTPS pages never hit mixed-content
  // errors and local dev behaves identically to production.
  if (u.protocol === "http:" && !opts.allowPlainHttp) {
    u.protocol = "https:";
    if (u.port === "80") u.port = "";
  }

  return { ok: true, url: u.href };
}

/**
 * Parse and filter HTTP request headers from guest into a safe Headers object
 * plus extracted metadata (host, contentLength, isChunked, expectContinue).
 */
export function sanitizeHeaders(headerLines) {
  const headers = new Headers();
  let host = "";
  let contentLength = 0;
  let hasContentLength = false;
  let isChunked = false;
  let expectContinue = false;

  for (const line of headerLines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return { ok: false, error: `Invalid header line: ${line}` };
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
      return { ok: false, error: `Invalid header name: ${name}` };
    }
    if (/[\r\n\0]/.test(value)) {
      return { ok: false, error: `Invalid header value for ${name}` };
    }

    const lower = name.toLowerCase();
    if (lower === "host") {
      host = value;
      continue;
    }
    if (lower === "content-length") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: `Invalid Content-Length: ${value}` };
      }
      contentLength = n;
      hasContentLength = true;
      continue;
    }
    if (lower === "transfer-encoding") {
      if (value.toLowerCase().includes("chunked")) isChunked = true;
      continue;
    }
    if (lower === "expect") {
      if (value.toLowerCase().includes("100-continue")) expectContinue = true;
      continue;
    }
    if (
      FORBIDDEN_REQ_HEADERS.has(lower) ||
      lower.startsWith("sec-") ||
      lower.startsWith("proxy-")
    ) {
      continue;
    }
    try {
      headers.append(name, value);
    } catch (e) {
      // Drop any header rejected by the host fetch Headers implementation.
    }
  }

  return { ok: true, headers, host, contentLength, hasContentLength, isChunked, expectContinue };
}

/**
 * Incrementally parse HTTP/1.1 chunked transfer-encoding.
 * Returns:
 *   { status: "need-more" }
 *   { status: "done", body: Uint8Array }
 *   { status: "error", code: number, reason: string }
 */
export function decodeChunkedBody(buf, maxBytes) {
  const pieces = [];
  let total = 0;
  let pos = 0;

  while (true) {
    // Find CRLF ending the chunk size line.
    let lineEnd = -1;
    for (let i = pos; i + 1 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10) {
        lineEnd = i;
        break;
      }
    }
    if (lineEnd === -1) {
      if (buf.length - pos > 128) {
        return { status: "error", code: 400, reason: "Malformed chunked length line." };
      }
      return { status: "need-more" };
    }

    const sizeLine = textDecoder.decode(buf.subarray(pos, lineEnd)).split(";")[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeLine)) {
      return { status: "error", code: 400, reason: "Invalid chunk size." };
    }
    const chunkLen = parseInt(sizeLine, 16);
    if (!Number.isSafeInteger(chunkLen) || chunkLen < 0) {
      return { status: "error", code: 400, reason: "Chunk size overflow." };
    }

    pos = lineEnd + 2;
    if (chunkLen === 0) {
      // Expect terminating CRLF (or optional trailers ending with CRLFCRLF).
      if (pos + 1 < buf.length && buf[pos] === 13 && buf[pos + 1] === 10) {
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of pieces) { out.set(p, off); off += p.length; }
        return { status: "done", body: out };
      }
      // Look for end of trailers (\r\n\r\n).
      for (let i = pos; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of pieces) { out.set(p, off); off += p.length; }
          return { status: "done", body: out };
        }
      }
      return { status: "need-more" };
    }

    if (total + chunkLen > maxBytes) {
      return { status: "error", code: 413, reason: "Request body exceeds maximum size." };
    }
    if (pos + chunkLen + 2 > buf.length) {
      return { status: "need-more" };
    }
    if (buf[pos + chunkLen] !== 13 || buf[pos + chunkLen + 1] !== 10) {
      return { status: "error", code: 400, reason: "Missing CRLF after chunk data." };
    }
    pieces.push(buf.subarray(pos, pos + chunkLen));
    total += chunkLen;
    pos += chunkLen + 2;
  }
}

/* ---------- Packet Checksum, Parsing & Encoding ---------- */

export function checksum16(bytes, start = 0, len = bytes.length - start, seed = 0) {
  let sum = seed;
  const end = start + (len & ~1);
  for (let i = start; i < end; i += 2) {
    sum += (bytes[i] << 8) | bytes[i + 1];
  }
  if (len & 1) {
    sum += bytes[start + len - 1] << 8;
  }
  while (sum >>> 16) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

function pseudoHeaderSeed(srcIp, dstIp, proto, len) {
  return (
    ((srcIp[0] << 8) | srcIp[1]) +
    ((srcIp[2] << 8) | srcIp[3]) +
    ((dstIp[0] << 8) | dstIp[1]) +
    ((dstIp[2] << 8) | dstIp[3]) +
    proto +
    len
  );
}

export function buildServfailDns(queryBytes, rcode = 2) {
  if (!queryBytes || queryBytes.length < 12) return null;
  // Echo header + question section cleanly when valid, setting QR=1, RA=1, RCODE=rcode.
  const out = new Uint8Array(Math.min(queryBytes.length, 512));
  out.set(queryBytes.subarray(0, out.length));
  const rd = out[2] & 0x01;
  out[2] = 0x80 | rd;                // QR=1, Opcode=0, AA=0, TC=0, RD preserved
  out[3] = 0x80 | (rcode & 0x0f);    // RA=1, Z=0, RCODE
  // Zero ANCOUNT, NSCOUNT, ARCOUNT
  out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0;
  out[10] = 0; out[11] = 0;
  return out;
}

export function parseEthFrame(frame) {
  if (!frame || frame.length < 14) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const ethertype = view.getUint16(12);
  const eth = {
    dest: frame.subarray(0, 6),
    src: frame.subarray(6, 12),
    ethertype,
  };
  const payload = frame.subarray(14);

  if (ethertype === 0x0806) {
    if (payload.length < 28) return null;
    const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      eth,
      arp: {
        htype: pv.getUint16(0),
        ptype: pv.getUint16(2),
        oper: pv.getUint16(6),
        sha: payload.subarray(8, 14),
        spa: payload.subarray(14, 18),
        tha: payload.subarray(18, 24),
        tpa: payload.subarray(24, 28),
      },
    };
  }

  if (ethertype !== 0x0800 || payload.length < 20) return null;
  const iv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = payload[0] >> 4;
  const ihl = (payload[0] & 0x0f) * 4;
  const totalLen = iv.getUint16(2);
  if (version !== 4 || ihl < 20 || totalLen < ihl || totalLen > payload.length) return null;

  const proto = payload[9];
  const ipv4 = {
    proto,
    ihl,
    len: totalLen,
    src: payload.subarray(12, 16),
    dest: payload.subarray(16, 20),
    rawHeader: payload.subarray(0, ihl),
  };
  const l4 = payload.subarray(ihl, totalLen);

  if (proto === 1 && l4.length >= 8) {
    const cv = new DataView(l4.buffer, l4.byteOffset, l4.byteLength);
    return {
      eth,
      ipv4,
      icmp: {
        type: l4[0],
        code: l4[1],
        id: cv.getUint16(4),
        seq: cv.getUint16(6),
        data: l4.subarray(4),
      },
    };
  }

  if (proto === 6 && l4.length >= 20) {
    const tv = new DataView(l4.buffer, l4.byteOffset, l4.byteLength);
    const doff = (l4[12] >> 4) * 4;
    if (doff < 20 || doff > l4.length) return null;
    const flags = l4[13];
    return {
      eth,
      ipv4,
      tcp: {
        sport: tv.getUint16(0),
        dport: tv.getUint16(2),
        seq: tv.getUint32(4),
        ackn: tv.getUint32(8),
        winsize: tv.getUint16(14),
        fin: !!(flags & 0x01),
        syn: !!(flags & 0x02),
        rst: !!(flags & 0x04),
        psh: !!(flags & 0x08),
        ack: !!(flags & 0x10),
      },
      tcpData: l4.subarray(doff),
    };
  }

  if (proto === 17 && l4.length >= 8) {
    const uv = new DataView(l4.buffer, l4.byteOffset, l4.byteLength);
    const ulen = uv.getUint16(4);
    if (ulen < 8 || ulen > l4.length) return null;
    return {
      eth,
      ipv4,
      udp: {
        sport: uv.getUint16(0),
        dport: uv.getUint16(2),
        len: ulen,
        data: l4.subarray(8, ulen),
      },
    };
  }

  return { eth, ipv4 };
}

export function encodeEthFrame(pkt) {
  let l3Len = 0;
  if (pkt.arp) {
    l3Len = 28;
  } else if (pkt.ipv4) {
    if (pkt.icmp) {
      l3Len = 20 + 4 + pkt.icmp.data.length;
    } else if (pkt.udp) {
      l3Len = 20 + 8 + pkt.udp.data.length;
    } else if (pkt.tcp) {
      const optLen = pkt.tcp.mss ? 4 : 0;
      const dataLen = pkt.tcpData ? pkt.tcpData.length : 0;
      l3Len = 20 + 20 + optLen + dataLen;
    }
  }

  const rawLen = 14 + l3Len;
  const frameLen = Math.max(60, rawLen);
  const buf = new Uint8Array(frameLen);
  const view = new DataView(buf.buffer);

  buf.set(pkt.eth.dest, 0);
  buf.set(pkt.eth.src, 6);
  view.setUint16(12, pkt.eth.ethertype);

  if (pkt.arp) {
    view.setUint16(14, pkt.arp.htype);
    view.setUint16(16, pkt.arp.ptype);
    buf[18] = 6;
    buf[19] = 4;
    view.setUint16(20, pkt.arp.oper);
    buf.set(pkt.arp.sha, 22);
    buf.set(pkt.arp.spa, 28);
    buf.set(pkt.arp.tha, 32);
    buf.set(pkt.arp.tpa, 38);
    return buf;
  }

  if (pkt.ipv4) {
    buf[14] = 0x45; // IPv4, IHL=5 (20 bytes)
    buf[15] = 0;
    view.setUint16(16, l3Len);
    view.setUint16(18, pkt.ipv4.id || 0);
    view.setUint16(20, 0x4000); // DF
    buf[22] = pkt.ipv4.ttl || 64;
    buf[23] = pkt.ipv4.proto;
    view.setUint16(24, 0);
    buf.set(pkt.ipv4.src, 26);
    buf.set(pkt.ipv4.dest, 30);
    view.setUint16(24, checksum16(buf, 14, 20));

    const l4Off = 34;
    if (pkt.icmp) {
      const icmpLen = 4 + pkt.icmp.data.length;
      buf[l4Off] = pkt.icmp.type;
      buf[l4Off + 1] = pkt.icmp.code || 0;
      view.setUint16(l4Off + 2, 0);
      buf.set(pkt.icmp.data, l4Off + 4);
      view.setUint16(l4Off + 2, checksum16(buf, l4Off, icmpLen));
    } else if (pkt.udp) {
      const udpLen = 8 + pkt.udp.data.length;
      view.setUint16(l4Off, pkt.udp.sport);
      view.setUint16(l4Off + 2, pkt.udp.dport);
      view.setUint16(l4Off + 4, udpLen);
      view.setUint16(l4Off + 6, 0);
      buf.set(pkt.udp.data, l4Off + 8);
      const seed = pseudoHeaderSeed(pkt.ipv4.src, pkt.ipv4.dest, 17, udpLen);
      const sum = checksum16(buf, l4Off, udpLen, seed);
      view.setUint16(l4Off + 6, sum === 0 ? 0xffff : sum);
    } else if (pkt.tcp) {
      const t = pkt.tcp;
      const optLen = t.mss ? 4 : 0;
      const hdrLen = 20 + optLen;
      const dataLen = pkt.tcpData ? pkt.tcpData.length : 0;
      const tcpLen = hdrLen + dataLen;
      let flags = 0;
      if (t.fin) flags |= 0x01;
      if (t.syn) flags |= 0x02;
      if (t.rst) flags |= 0x04;
      if (t.psh) flags |= 0x08;
      if (t.ack) flags |= 0x10;

      view.setUint16(l4Off, t.sport);
      view.setUint16(l4Off + 2, t.dport);
      view.setUint32(l4Off + 4, t.seq >>> 0);
      view.setUint32(l4Off + 8, t.ackn >>> 0);
      buf[l4Off + 12] = (hdrLen / 4) << 4;
      buf[l4Off + 13] = flags;
      view.setUint16(l4Off + 14, t.winsize !== undefined ? t.winsize : 65535);
      view.setUint16(l4Off + 16, 0);
      view.setUint16(l4Off + 18, 0);
      if (t.mss) {
        buf[l4Off + 20] = 2;
        buf[l4Off + 21] = 4;
        view.setUint16(l4Off + 22, t.mss);
      }
      if (dataLen > 0) {
        buf.set(pkt.tcpData, l4Off + hdrLen);
      }
      const seed = pseudoHeaderSeed(pkt.ipv4.src, pkt.ipv4.dest, 6, tcpLen);
      view.setUint16(l4Off + 16, checksum16(buf, l4Off, tcpLen, seed));
    }
  }

  return buf;
}

function findHeaderEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function concatBytes(a, b) {
  if (!a || a.length === 0) return b.slice();
  if (!b || b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ---------- Bounded Virtual TCP Connection ---------- */

class VirtualHttpConnection {
  constructor(adapter, tuple, synPkt) {
    this.adapter = adapter;
    this.tuple = tuple;
    this.guestMac = new Uint8Array(synPkt.eth.src);
    this.guestIp = new Uint8Array(synPkt.ipv4.src);
    this.remoteIp = new Uint8Array(synPkt.ipv4.dest);
    this.guestPort = synPkt.tcp.sport;
    this.remotePort = synPkt.tcp.dport;

    this.state = "established";
    this.seq = (0x10000000 + Math.floor(Math.random() * 0x6fffffff)) >>> 0;
    this.ack = (synPkt.tcp.seq + 1) >>> 0;
    this.lastAckedSeq = this.seq;

    // Outbound send queue (host -> guest) with strict backpressure
    this.sendChunks = [];
    this.sendOffset = 0;
    this.sendQueuedBytes = 0;
    this.inFlightBuf = null;
    this.inFlightSeq = 0;
    this.inFlightFin = false;
    this.retransmits = 0;
    this.retransmitTimer = null;
    this.drainWaiters = [];

    // HTTP request parsing state (guest -> host)
    this.reqPhase = "headers"; // "headers" | "body-cl" | "body-chunked" | "fetching" | "done"
    this.reqBuf = new Uint8Array(0);
    this.reqMeta = null;
    this.finQueued = false;
    this.headersSent = false;
    this.closed = false;
    this.lastActivity = Date.now();

    this.abortController = null;
    this.fetchTimeout = null;
    this.activeReader = null;
  }

  sendSynAck() {
    const synSeq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    this.lastAckedSeq = this.seq;
    this.adapter.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.adapter.routerMac, dest: this.guestMac },
      ipv4: { proto: 6, src: this.remoteIp, dest: this.guestIp },
      tcp: {
        sport: this.remotePort,
        dport: this.guestPort,
        seq: synSeq,
        ackn: this.ack,
        syn: true,
        ack: true,
        mss: this.adapter.limits.mss,
      },
    }));
  }

  sendSegment(flags, payload = null, seqOverride = null) {
    this.adapter.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.adapter.routerMac, dest: this.guestMac },
      ipv4: { proto: 6, src: this.remoteIp, dest: this.guestIp },
      tcp: {
        sport: this.remotePort,
        dport: this.guestPort,
        seq: seqOverride !== null ? seqOverride : this.seq,
        ackn: this.ack,
        ...flags,
      },
      tcpData: payload,
    }));
  }

  touch() {
    this.lastActivity = Date.now();
  }

  clearRetransmit() {
    if (this.retransmitTimer) {
      clearTimeout(this.retransmitTimer);
      this.retransmitTimer = null;
    }
  }

  clearFetchTimeout() {
    if (this.fetchTimeout) {
      clearTimeout(this.fetchTimeout);
      this.fetchTimeout = null;
    }
  }

  resetFetchTimeout() {
    this.clearFetchTimeout();
    this.fetchTimeout = setTimeout(() => {
      if (this.closed) return;
      this.abortFetch("timeout");
      if (!this.headersSent) {
        this.respondTextAndClose(504, "Gateway Timeout", "GoLinux network: request timed out.");
      } else {
        this.abortAndReset();
      }
    }, this.adapter.limits.requestTimeoutMs);
  }

  abortFetch(reason) {
    this.clearFetchTimeout();
    if (this.activeReader) {
      try { this.activeReader.cancel(reason).catch(() => {}); } catch (e) {}
      this.activeReader = null;
    }
    if (this.abortController) {
      try { this.abortController.abort(reason); } catch (e) {}
      this.abortController = null;
    }
    this.wakeDrainWaiters();
  }

  wakeDrainWaiters() {
    if (this.drainWaiters.length === 0) return;
    const list = this.drainWaiters.splice(0, this.drainWaiters.length);
    for (const fn of list) fn();
  }

  waitForDrain() {
    if (this.closed || this.sendQueuedBytes < this.adapter.limits.highWaterBytes) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  enqueueData(chunk) {
    if (this.closed || !chunk || chunk.length === 0) return;
    this.sendChunks.push(chunk);
    this.sendQueuedBytes += chunk.length;
    this.pump();
  }

  enqueueFin() {
    if (this.closed) return;
    this.finQueued = true;
    this.pump();
  }

  popChunk(maxLen) {
    const out = new Uint8Array(Math.min(maxLen, this.sendQueuedBytes));
    let written = 0;
    while (written < out.length && this.sendChunks.length > 0) {
      const head = this.sendChunks[0];
      const avail = head.length - this.sendOffset;
      const take = Math.min(avail, out.length - written);
      out.set(head.subarray(this.sendOffset, this.sendOffset + take), written);
      written += take;
      this.sendOffset += take;
      if (this.sendOffset >= head.length) {
        this.sendChunks.shift();
        this.sendOffset = 0;
      }
    }
    this.sendQueuedBytes -= written;
    if (this.sendQueuedBytes <= this.adapter.limits.lowWaterBytes) {
      this.wakeDrainWaiters();
    }
    return out;
  }

  scheduleRetransmit() {
    this.clearRetransmit();
    const delay = this.adapter.limits.retransmitBaseMs * Math.pow(2, Math.min(this.retransmits, 4));
    this.retransmitTimer = setTimeout(() => {
      this.retransmitTimer = null;
      if (this.closed || (!this.inFlightBuf && !this.inFlightFin)) return;
      if (this.retransmits >= this.adapter.limits.maxRetransmits) {
        this.abortAndReset();
        return;
      }
      this.retransmits++;
      this.sendSegment(
        { ack: true, psh: !!this.inFlightBuf, fin: this.inFlightFin },
        this.inFlightBuf,
        this.inFlightSeq
      );
      this.scheduleRetransmit();
    }, delay);
  }

  pump() {
    if (this.closed || this.inFlightBuf || this.inFlightFin) return;

    if (this.sendQueuedBytes > 0) {
      const chunk = this.popChunk(this.adapter.limits.mss);
      this.inFlightSeq = this.seq;
      this.inFlightBuf = chunk;
      this.inFlightFin = false;
      this.retransmits = 0;
      this.seq = (this.seq + chunk.length) >>> 0;
      this.sendSegment({ ack: true, psh: true }, chunk, this.inFlightSeq);
      this.scheduleRetransmit();
      return;
    }

    if (this.finQueued && this.state !== "fin-wait-1" && this.state !== "last-ack") {
      this.finQueued = false;
      this.inFlightSeq = this.seq;
      this.inFlightBuf = null;
      this.inFlightFin = true;
      this.retransmits = 0;
      this.seq = (this.seq + 1) >>> 0;
      this.state = this.state === "close-wait" ? "last-ack" : "fin-wait-1";
      this.sendSegment({ ack: true, fin: true }, null, this.inFlightSeq);
      this.scheduleRetransmit();
    }
  }

  handlePacket(pkt) {
    if (this.closed) return;
    this.touch();
    const t = pkt.tcp;

    if (t.rst) {
      this.destroy();
      return;
    }

    // Handle ACK advancement using signed 32-bit modular arithmetic.
    if (t.ack) {
      const ackDiff = (t.ackn - this.lastAckedSeq) | 0;
      const inFlightSpan = (this.seq - this.lastAckedSeq) | 0;
      if (ackDiff > 0 && ackDiff <= inFlightSpan) {
        this.lastAckedSeq = t.ackn >>> 0;
        if (this.lastAckedSeq === this.seq) {
          this.clearRetransmit();
          const wasFin = this.inFlightFin;
          this.inFlightBuf = null;
          this.inFlightFin = false;
          this.retransmits = 0;
          if (wasFin && this.state === "last-ack") {
            this.destroy();
            return;
          }
          if (wasFin && this.state === "fin-wait-1") {
            this.state = "fin-wait-2";
          }
        }
      }
    }

    // Handle incoming payload in order.
    if (pkt.tcpData && pkt.tcpData.length > 0) {
      if ((t.seq >>> 0) === this.ack) {
        this.ack = (this.ack + pkt.tcpData.length) >>> 0;
        this.sendSegment({ ack: true });
        this.onGuestBytes(pkt.tcpData);
      } else {
        // Out-of-order: send duplicate ACK with expected seq.
        this.sendSegment({ ack: true });
      }
    }

    // Handle FIN from guest.
    if (t.fin) {
      if ((t.seq >>> 0) === this.ack || (pkt.tcpData && ((t.seq + pkt.tcpData.length) >>> 0) === this.ack)) {
        this.ack = (this.ack + 1) >>> 0;
        this.sendSegment({ ack: true });
        if (this.state === "fin-wait-2") {
          this.destroy();
          return;
        }
        if (this.state === "fin-wait-1") {
          this.state = "closing";
          this.destroy();
          return;
        }
        // Guest closed write side (e.g. curl finished sending request, or Ctrl+C).
        this.state = "close-wait";
        if (this.reqPhase === "headers" && this.reqBuf.length === 0) {
          this.enqueueFin();
        }
      }
    }

    this.pump();
  }

  onGuestBytes(data) {
    if (this.reqPhase === "fetching" || this.reqPhase === "done") return;

    if (this.reqPhase === "headers") {
      this.reqBuf = concatBytes(this.reqBuf, data);
      const end = findHeaderEnd(this.reqBuf);
      if (end === -1) {
        if (this.reqBuf.length > this.adapter.limits.maxHeaderBytes) {
          this.respondTextAndClose(431, "Request Header Fields Too Large", "HTTP headers exceed 16 KiB limit.");
        }
        return;
      }
      const headBytes = this.reqBuf.subarray(0, end);
      const restBytes = this.reqBuf.subarray(end + 4);
      this.reqBuf = new Uint8Array(0);
      this.parseRequestHead(headBytes, restBytes);
      return;
    }

    if (this.reqPhase === "body-cl") {
      if (this.reqBuf.length + data.length > this.adapter.limits.maxRequestBodyBytes) {
        this.respondTextAndClose(413, "Payload Too Large", "Request body exceeds 4 MiB limit.");
        return;
      }
      this.reqBuf = concatBytes(this.reqBuf, data);
      if (this.reqBuf.length >= this.reqMeta.contentLength) {
        const body = this.reqBuf.subarray(0, this.reqMeta.contentLength);
        this.reqBuf = new Uint8Array(0);
        this.startFetch(body);
      }
      return;
    }

    if (this.reqPhase === "body-chunked") {
      if (this.reqBuf.length + data.length > this.adapter.limits.maxRequestBodyBytes + 65536) {
        this.respondTextAndClose(413, "Payload Too Large", "Chunked request body exceeds 4 MiB limit.");
        return;
      }
      this.reqBuf = concatBytes(this.reqBuf, data);
      const decoded = decodeChunkedBody(this.reqBuf, this.adapter.limits.maxRequestBodyBytes);
      if (decoded.status === "error") {
        this.respondTextAndClose(decoded.code, "Bad Request", decoded.reason);
      } else if (decoded.status === "done") {
        this.reqBuf = new Uint8Array(0);
        this.startFetch(decoded.body);
      }
    }
  }

  parseRequestHead(headBytes, restBytes) {
    const lines = textDecoder.decode(headBytes).split("\r\n");
    const reqLine = (lines[0] || "").trim().split(/\s+/);
    if (reqLine.length < 2) {
      this.respondTextAndClose(400, "Bad Request", "Malformed HTTP request line.");
      return;
    }
    const method = reqLine[0].toUpperCase();
    const rawTarget = reqLine[1];

    if (method === "CONNECT") {
      this.respondTextAndClose(
        501,
        "Not Implemented",
        "GoLinux zero-server mode cannot tunnel CONNECT/TLS sockets. Use http:// URLs (auto-upgraded to HTTPS by the browser)."
      );
      return;
    }

    const parsed = sanitizeHeaders(lines.slice(1));
    if (!parsed.ok) {
      this.respondTextAndClose(400, "Bad Request", parsed.error);
      return;
    }

    let rawUrl;
    if (/^https?:\/\//i.test(rawTarget)) {
      rawUrl = rawTarget;
    } else if (parsed.host) {
      const pathPart = rawTarget.startsWith("/") ? rawTarget : "/" + rawTarget;
      rawUrl = "http://" + parsed.host + pathPart;
    } else {
      this.respondTextAndClose(400, "Bad Request", "Missing Host header.");
      return;
    }

    const check = validateTargetUrl(rawUrl, this.adapter.urlOpts);
    if (!check.ok) {
      this.respondTextAndClose(check.status, check.status === 403 ? "Forbidden" : "Bad Request", check.reason);
      return;
    }

    this.reqMeta = {
      method,
      url: check.url,
      headers: parsed.headers,
      contentLength: parsed.contentLength,
      hasContentLength: parsed.hasContentLength,
      isChunked: parsed.isChunked,
    };

    if (parsed.expectContinue) {
      this.enqueueData(textEncoder.encode("HTTP/1.1 100 Continue\r\n\r\n"));
    }

    const canHaveBody = method !== "GET" && method !== "HEAD";
    if (canHaveBody && parsed.isChunked) {
      this.reqPhase = "body-chunked";
      if (restBytes.length > 0) {
        this.onGuestBytes(restBytes);
      }
      return;
    }

    if (canHaveBody && parsed.hasContentLength && parsed.contentLength > 0) {
      if (parsed.contentLength > this.adapter.limits.maxRequestBodyBytes) {
        this.respondTextAndClose(413, "Payload Too Large", "Request body exceeds 4 MiB limit.");
        return;
      }
      if (restBytes.length >= parsed.contentLength) {
        this.startFetch(restBytes.subarray(0, parsed.contentLength));
      } else {
        this.reqPhase = "body-cl";
        this.reqBuf = restBytes.slice();
      }
      return;
    }

    this.startFetch(canHaveBody && restBytes.length > 0 ? restBytes : null);
  }

  async startFetch(bodyBytes) {
    if (this.closed) return;
    this.reqPhase = "fetching";
    this.abortController = new AbortController();
    this.resetFetchTimeout();

    let currentUrl = this.reqMeta.url;
    let currentMethod = this.reqMeta.method;
    let currentHeaders = this.reqMeta.headers;
    let currentBody = (bodyBytes && bodyBytes.length > 0 && currentMethod !== "GET" && currentMethod !== "HEAD")
      ? bodyBytes
      : null;

    try {
      let res = null;
      const MAX_REDIRECTS = 4;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const init = {
          method: currentMethod,
          headers: currentHeaders,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          mode: "cors",
          redirect: "manual",
          signal: this.abortController.signal,
        };
        if (currentBody && currentMethod !== "GET" && currentMethod !== "HEAD") {
          init.body = currentBody;
        }
        res = await this.adapter.fetchImpl(currentUrl, init);
        if (this.closed) return;

        if (res.type === "opaqueredirect") {
          this.respondTextAndClose(502, "Bad Gateway", "GoLinux network: opaque cross-origin redirect blocked for safety.");
          return;
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && typeof res.headers.get === "function" ? res.headers.get("location") : "";
          if (!loc) break;
          if (hop === MAX_REDIRECTS) {
            this.respondTextAndClose(502, "Bad Gateway", "GoLinux network: too many redirects.");
            return;
          }
          let resolved;
          try {
            resolved = new URL(loc, currentUrl).href;
          } catch (_) {
            this.respondTextAndClose(502, "Bad Gateway", "GoLinux network: malformed redirect Location.");
            return;
          }
          const redirCheck = validateTargetUrl(resolved, this.adapter.urlOpts);
          if (!redirCheck.ok) {
            this.respondTextAndClose(redirCheck.status, redirCheck.status === 403 ? "Forbidden" : "Bad Request", redirCheck.reason);
            return;
          }
          currentUrl = redirCheck.url;
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
            currentMethod = "GET";
            currentBody = null;
            currentHeaders = new Headers(currentHeaders);
            currentHeaders.delete("content-type");
            currentHeaders.delete("content-length");
          }
          continue;
        }
        break;
      }
      if (!res) throw new Error("No response");

      const headLines = [`HTTP/1.1 ${res.status} ${res.statusText || "OK"}`];
      if (res.headers && typeof res.headers.forEach === "function") {
        res.headers.forEach((val, key) => {
          if (!STRIP_RESP_HEADERS.has(key.toLowerCase())) {
            headLines.push(`${key}: ${val}`);
          }
        });
      }
      headLines.push(`x-golinux-fetched-url: ${res.url || currentUrl}`);
      headLines.push("connection: close");

      this.headersSent = true;
      this.enqueueData(textEncoder.encode(headLines.join("\r\n") + "\r\n\r\n"));

      const noBody = this.reqMeta.method === "HEAD" || res.status === 204 || res.status === 304 || !res.body;
      if (noBody) {
        this.clearFetchTimeout();
        this.reqPhase = "done";
        this.enqueueFin();
        return;
      }

      if (typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        this.activeReader = reader;
        let received = 0;

        while (!this.closed) {
          await this.waitForDrain();
          if (this.closed) break;

          this.resetFetchTimeout();
          const { done, value } = await reader.read();
          if (this.closed) break;
          if (done) break;

          if (value && value.byteLength > 0) {
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            received += chunk.byteLength;
            if (received > this.adapter.limits.maxResponseBytes) {
              this.abortFetch("max-response-bytes");
              this.abortAndReset();
              return;
            }
            this.enqueueData(chunk);
          }
        }
        this.activeReader = null;
      } else {
        const ab = await res.arrayBuffer();
        if (this.closed) return;
        if (ab.byteLength > this.adapter.limits.maxResponseBytes) {
          this.abortAndReset();
          return;
        }
        if (ab.byteLength > 0) this.enqueueData(new Uint8Array(ab));
      }

      this.clearFetchTimeout();
      this.reqPhase = "done";
      if (!this.closed) this.enqueueFin();
    } catch (err) {
      this.clearFetchTimeout();
      if (this.closed) return;
      if (err && err.name === "AbortError") {
        if (!this.headersSent) {
          this.respondTextAndClose(504, "Gateway Timeout", "GoLinux network: request aborted or timed out.");
        } else {
          this.abortAndReset();
        }
        return;
      }
      if (!this.headersSent) {
        const msg =
          `GoLinux zero-server network: fetch failed for ${this.reqMeta.url}\n` +
          `Reason: ${err && err.message ? err.message : "Network/CORS error"}\n\n` +
          "Hint: Without a relay server, browsers only allow CORS-enabled HTTPS endpoints\n" +
          "(for example: curl http://api.github.com/zen or curl http://wttr.in/?format=3).\n";
        this.respondTextAndClose(502, "Bad Gateway", msg);
      } else {
        this.abortAndReset();
      }
    }
  }

  respondTextAndClose(status, statusText, text) {
    if (this.closed) return;
    this.reqPhase = "done";
    const body = textEncoder.encode(text.endsWith("\n") ? text : text + "\n");
    const head = textEncoder.encode(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `Connection: close\r\n\r\n`
    );
    this.headersSent = true;
    this.enqueueData(head);
    this.enqueueData(body);
    this.enqueueFin();
  }

  abortAndReset() {
    if (this.closed) return;
    this.sendSegment({ rst: true, ack: true });
    this.destroy();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearRetransmit();
    this.abortFetch("conn-destroyed");
    this.sendChunks.length = 0;
    this.sendQueuedBytes = 0;
    this.inFlightBuf = null;
    this.adapter.conns.delete(this.tuple);
  }
}

/* ---------- Main Adapter ---------- */

export class SafeFetchNetworkAdapter {
  constructor(bus, opts = {}) {
    this.bus = bus;
    this.id = opts.id || 0;
    this.routerMac = opts.routerMac ? new Uint8Array(opts.routerMac) : new Uint8Array(DEFAULT_ROUTER_MAC);
    this.routerIp = opts.routerIp ? new Uint8Array(opts.routerIp) : new Uint8Array(DEFAULT_ROUTER_IP);
    this.vmIp = opts.vmIp ? new Uint8Array(opts.vmIp) : new Uint8Array(DEFAULT_VM_IP);
    this.vmMac = new Uint8Array(6);

    this.limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
    this.dohUrl = opts.dohUrl || DEFAULT_DOH_URL;
    this.onBlockedPort = typeof opts.onBlockedPort === "function" ? opts.onBlockedPort : null;
    this.onStateChange = typeof opts.onStateChange === "function" ? opts.onStateChange : null;

    const blockedHosts = new Set(opts.blockedHosts || []);
    if (typeof location !== "undefined" && location.hostname) {
      blockedHosts.add(location.hostname.toLowerCase());
    }
    if (typeof GL_ASSET_ORIGIN === "string" && GL_ASSET_ORIGIN) {
      try { blockedHosts.add(new URL(GL_ASSET_ORIGIN).hostname.toLowerCase()); } catch (e) {}
    }

    this.urlOpts = {
      blockedHosts,
      allowedTestHosts: opts.allowedTestHosts || null,
      allowPlainHttp: !!opts.allowPlainHttp,
    };

    this.enabled = !!opts.enabled;
    this.destroyed = false;
    this.conns = new Map();
    this.dnsControllers = new Set();
    this.stats = { requests: 0, dnsQueries: 0, blockedPorts: 0 };

    this._onMac = (macStr) => {
      if (typeof macStr !== "string") return;
      const parts = macStr.split(":").map((h) => parseInt(h, 16));
      if (parts.length === 6 && parts.every((n) => !Number.isNaN(n))) {
        this.vmMac = new Uint8Array(parts);
      }
    };
    this._onSend = (frame) => {
      if (this.destroyed) return;
      try {
        this.handleGuestFrame(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
      } catch (e) {
        // Never allow a malformed guest packet to crash the emulator loop.
      }
    };

    this.bus.register("net" + this.id + "-mac", this._onMac, this);
    this.bus.register("net" + this.id + "-send", this._onSend, this);

    this._reaper = setInterval(() => this.reapIdleConnections(), 10000);
    if (this._reaper && typeof this._reaper.unref === "function") {
      this._reaper.unref();
    }
  }

  isEnabled() {
    return this.enabled && !this.destroyed;
  }

  setEnabled(next) {
    const val = !!next;
    if (this.destroyed || this.enabled === val) return this.enabled;
    this.enabled = val;
    if (!val) {
      this.abortAllActive();
    }
    if (this.onStateChange) {
      try { this.onStateChange(this.enabled); } catch (e) {}
    }
    return this.enabled;
  }

  emitFrame(frame) {
    if (this.destroyed) return;
    this.bus.send("net" + this.id + "-receive", frame);
  }

  abortAllActive() {
    for (const conn of Array.from(this.conns.values())) {
      conn.abortAndReset();
    }
    this.conns.clear();
    for (const ctrl of Array.from(this.dnsControllers)) {
      try { ctrl.abort("adapter-disabled"); } catch (e) {}
    }
    this.dnsControllers.clear();
  }

  reapIdleConnections() {
    if (this.destroyed) return;
    const now = Date.now();
    for (const conn of Array.from(this.conns.values())) {
      if (now - conn.lastActivity > this.limits.idleConnTimeoutMs) {
        conn.abortAndReset();
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    if (this._reaper) {
      clearInterval(this._reaper);
      this._reaper = null;
    }
    for (const conn of Array.from(this.conns.values())) {
      conn.destroy();
    }
    this.conns.clear();
    for (const ctrl of Array.from(this.dnsControllers)) {
      try { ctrl.abort("adapter-destroyed"); } catch (e) {}
    }
    this.dnsControllers.clear();
    if (typeof this.bus.unregister === "function") {
      this.bus.unregister("net" + this.id + "-mac", this._onMac);
      this.bus.unregister("net" + this.id + "-send", this._onSend);
    }
  }

  handleGuestFrame(frame) {
    const pkt = parseEthFrame(frame);
    if (!pkt) return;

    if (pkt.arp) {
      this.handleArp(pkt);
      return;
    }
    if (!pkt.ipv4) return;

    if (pkt.icmp) {
      this.handleIcmp(pkt);
      return;
    }
    if (pkt.udp) {
      this.handleUdp(pkt);
      return;
    }
    if (pkt.tcp) {
      this.handleTcp(pkt);
    }
  }

  isRouterIp(ip) {
    return (
      ip[0] === this.routerIp[0] &&
      ip[1] === this.routerIp[1] &&
      ip[2] === this.routerIp[2] &&
      ip[3] === this.routerIp[3]
    );
  }

  handleArp(pkt) {
    if (pkt.arp.oper !== 1 || pkt.arp.ptype !== 0x0800) return;
    // Always answer ARP for the virtual gateway (192.168.86.1) so guest sockets
    // get fast RST/REFUSED instead of stalling on ARP timeout when disabled.
    const sameSubnet =
      pkt.arp.tpa[0] === this.routerIp[0] &&
      pkt.arp.tpa[1] === this.routerIp[1] &&
      pkt.arp.tpa[2] === this.routerIp[2];
    if (sameSubnet && pkt.arp.tpa[3] >= 100) return;

    this.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0806, src: this.routerMac, dest: pkt.eth.src },
      arp: {
        htype: 1,
        ptype: 0x0800,
        oper: 2,
        sha: this.routerMac,
        spa: pkt.arp.tpa,
        tha: pkt.eth.src,
        tpa: pkt.arp.spa,
      },
    }));
  }

  handleIcmp(pkt) {
    if (pkt.icmp.type !== 8) return; // Echo Request only
    if (this.isRouterIp(pkt.ipv4.dest)) {
      // Reply to local virtual gateway ping so `ping 192.168.86.1` checks link health.
      this.emitFrame(encodeEthFrame({
        eth: { ethertype: 0x0800, src: this.routerMac, dest: pkt.eth.src },
        ipv4: { proto: 1, src: pkt.ipv4.dest, dest: pkt.ipv4.src },
        icmp: { type: 0, code: 0, data: pkt.icmp.data },
      }));
      return;
    }
    // Browsers cannot emit raw ICMP to external hosts: reply cleanly with
    // Destination Unreachable (code 13 = Communication Administratively Prohibited).
    const quoted = new Uint8Array(4 + pkt.ipv4.rawHeader.length + 8);
    quoted.set(pkt.ipv4.rawHeader, 4);
    const l4Sample = pkt.icmp.data.subarray(0, Math.min(4, pkt.icmp.data.length));
    quoted[4 + pkt.ipv4.rawHeader.length] = pkt.icmp.type;
    quoted[4 + pkt.ipv4.rawHeader.length + 1] = pkt.icmp.code;
    quoted.set(l4Sample, 4 + pkt.ipv4.rawHeader.length + 4);
    this.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.routerMac, dest: pkt.eth.src },
      ipv4: { proto: 1, src: this.routerIp, dest: pkt.ipv4.src },
      icmp: { type: 3, code: 13, data: quoted },
    }));
  }

  handleUdp(pkt) {
    if (pkt.udp.dport === 67) {
      this.handleDhcp(pkt);
      return;
    }
    if (pkt.udp.dport === 53) {
      this.handleDns(pkt);
    }
  }

  handleDhcp(pkt) {
    const d = pkt.udp.data;
    if (d.length < 240) return;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const xid = dv.getUint32(4);
    const chaddr = d.subarray(28, 44);

    let msgType = 1; // Discover
    for (let i = 240; i < d.length; ) {
      const opt = d[i++];
      if (opt === 0) continue;
      if (opt === 255) break;
      const len = d[i++];
      if (opt === 53 && len >= 1) msgType = d[i];
      i += len;
    }

    const replyType = msgType === 3 ? 5 : 2; // ACK for Request, OFFER for Discover
    const opts = [
      new Uint8Array([53, 1, replyType]),
      new Uint8Array([51, 4, 0, 1, 81, 128]), // 86400s lease
      new Uint8Array([1, 4, 255, 255, 255, 0]),
      new Uint8Array([3, 4, ...this.routerIp]),
      new Uint8Array([6, 4, ...this.routerIp]),
      new Uint8Array([54, 4, ...this.routerIp]),
      new Uint8Array([255]),
    ];
    let optLen = 0;
    for (const o of opts) optLen += o.length;
    const out = new Uint8Array(240 + optLen);
    const ov = new DataView(out.buffer);
    out[0] = 2; out[1] = 1; out[2] = 6; out[3] = 0;
    ov.setUint32(4, xid);
    out.set(this.vmIp, 16);
    out.set(this.routerIp, 20);
    out.set(this.routerIp, 24);
    out.set(chaddr, 28);
    ov.setUint32(236, 0x63825363);
    let pos = 240;
    for (const o of opts) { out.set(o, pos); pos += o.length; }

    this.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.routerMac, dest: pkt.eth.src },
      ipv4: { proto: 17, src: this.routerIp, dest: this.vmIp },
      udp: { sport: 67, dport: 68, data: out },
    }));
  }

  sendUdpReply(origPkt, payload) {
    if (this.destroyed || !payload) return;
    this.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.routerMac, dest: origPkt.eth.src },
      ipv4: { proto: 17, src: origPkt.ipv4.dest, dest: origPkt.ipv4.src },
      udp: { sport: origPkt.udp.dport, dport: origPkt.udp.sport, data: payload },
    }));
  }

  handleDns(pkt) {
    const query = pkt.udp.data.slice();
    if (query.length < 12) return;

    if (!this.enabled) {
      // REFUSED (rcode 5) immediately so offline DNS never stalls for 15s.
      const refused = buildServfailDns(query, 5);
      if (refused) this.sendUdpReply(pkt, refused);
      return;
    }

    if (this.dnsControllers.size >= this.limits.maxConcurrentDns) {
      const sf = buildServfailDns(query, 2);
      if (sf) this.sendUdpReply(pkt, sf);
      return;
    }

    this.stats.dnsQueries++;
    const ctrl = new AbortController();
    this.dnsControllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort("doh-timeout"), this.limits.dohTimeoutMs);

    const origMeta = {
      eth: { src: pkt.eth.src.slice() },
      ipv4: { src: pkt.ipv4.src.slice(), dest: pkt.ipv4.dest.slice() },
      udp: { sport: pkt.udp.sport, dport: pkt.udp.dport },
    };

    Promise.resolve()
      .then(() =>
        this.fetchImpl(this.dohUrl, {
          method: "POST",
          headers: {
            "content-type": "application/dns-message",
            accept: "application/dns-message",
          },
          body: query,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          mode: "cors",
          signal: ctrl.signal,
        })
      )
      .then(async (res) => {
        if (!res || !res.ok) throw new Error("DoH HTTP " + (res ? res.status : "error"));
        const ctype = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
        if (!ctype.toLowerCase().includes("application/dns-message")) {
          throw new Error("Unexpected DoH Content-Type: " + ctype);
        }
        const cl = res.headers && res.headers.get ? Number(res.headers.get("content-length")) : 0;
        if (cl > this.limits.maxDnsUdpBytes) {
          throw new Error("DoH Content-Length exceeds limit: " + cl);
        }
        let bytes;
        if (res.body && typeof res.body.getReader === "function") {
          const reader = res.body.getReader();
          const parts = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
              total += value.byteLength;
              if (total > this.limits.maxDnsUdpBytes) {
                try { await reader.cancel(); } catch (_) {}
                throw new Error("DoH response stream exceeded limit");
              }
              parts.push(value);
            }
          }
          bytes = new Uint8Array(total);
          let off = 0;
          for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
        } else {
          const ab = await res.arrayBuffer();
          bytes = new Uint8Array(ab);
        }
        if (bytes.length < 12 || bytes.length > this.limits.maxDnsUdpBytes) {
          throw new Error("Invalid DoH payload length: " + bytes.length);
        }
        if (bytes[0] !== query[0] || bytes[1] !== query[1]) {
          throw new Error("DoH transaction ID mismatch");
        }
        if (!this.destroyed && this.enabled) {
          this.sendUdpReply(origMeta, bytes);
        }
      })
      .catch(() => {
        if (!this.destroyed) {
          const sf = buildServfailDns(query, 2);
          if (sf) this.sendUdpReply(origMeta, sf);
        }
      })
      .finally(() => {
        clearTimeout(timer);
        this.dnsControllers.delete(ctrl);
      });
  }

  sendTcpRst(pkt) {
    const t = pkt.tcp;
    const seq = t.ack ? t.ackn : 0;
    const ackn = (t.seq + (pkt.tcpData ? pkt.tcpData.length : 0) + (t.syn ? 1 : 0) + (t.fin ? 1 : 0)) >>> 0;
    this.emitFrame(encodeEthFrame({
      eth: { ethertype: 0x0800, src: this.routerMac, dest: pkt.eth.src },
      ipv4: { proto: 6, src: pkt.ipv4.dest, dest: pkt.ipv4.src },
      tcp: {
        sport: t.dport,
        dport: t.sport,
        seq,
        ackn,
        rst: true,
        ack: !t.ack,
      },
    }));
  }

  handleTcp(pkt) {
    const t = pkt.tcp;
    const tuple = `${pkt.ipv4.src.join(".")}:${t.sport}:${pkt.ipv4.dest.join(".")}:${t.dport}`;

    if (t.syn && !t.ack) {
      const existing = this.conns.get(tuple);
      if (existing) existing.destroy();

      if (!this.enabled) {
        this.sendTcpRst(pkt);
        return;
      }

      if (t.dport !== 80) {
        this.stats.blockedPorts++;
        this.sendTcpRst(pkt);
        if (this.onBlockedPort) {
          try { this.onBlockedPort(t.dport); } catch (e) {}
        }
        return;
      }

      if (this.conns.size >= this.limits.maxConcurrentConns) {
        this.sendTcpRst(pkt);
        return;
      }

      this.stats.requests++;
      const conn = new VirtualHttpConnection(this, tuple, pkt);
      this.conns.set(tuple, conn);
      conn.sendSynAck();
      return;
    }

    const conn = this.conns.get(tuple);
    if (!conn) {
      if (!t.rst) this.sendTcpRst(pkt);
      return;
    }
    conn.handlePacket(pkt);
  }
}
