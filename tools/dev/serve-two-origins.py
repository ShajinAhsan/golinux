#!/usr/bin/env python3
"""Two-origin test server that mimics the production split.

  origin A (app)   : http://127.0.0.1:8090  - index.html, JS, wasm, snapshot
  origin B (assets): http://127.0.0.1:8091  - disk chunks + packs

Origin B sends CORS headers and long-lived caching like an R2 custom domain
would, so we can check that cross-origin chunk fetches are usable by v86's XHR
and are not opaque to the page.

Usage: python3 tools/dev/serve-two-origins.py [--no-cors] [--no-cache-headers]
"""
import argparse
import http.server
import os
import posixpath
import socketserver
import sys
import threading
import urllib.parse

ROOT = os.path.realpath(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

# Only the files that belong on each origin in production.
# App origin serves everything EXCEPT images/debian-chunks/, images/debian-bundles/, bundles/, and packs/ (which belong on R2).
ASSET_PREFIXES = ("images/debian-chunks/", "images/debian-bundles/", "bundles/", "packs/")
APP_FORBIDDEN = ASSET_PREFIXES

CT = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".zst": "application/zstd",
    ".pack": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".png": "image/png",
}


REAL_CHUNKS = None


def load_real_chunks():
    """Chunks that production uploads: everything with actual data."""
    import json
    path = os.path.join(ROOT, "images", "debian-chunks", "manifest.json")
    try:
        return set(json.load(open(path))["real"])
    except Exception:
        return None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    cors = True
    cache_headers = True
    omit_empty = False
    is_asset = False

    def log_message(self, *args):
        pass

    def _serve(self, body):
        raw_path = urllib.parse.unquote(self.path.split("?")[0])
        if "\x00" in raw_path:
            self.send_error(400, "invalid path")
            return
        norm = posixpath.normpath("/" + raw_path).lstrip("/")
        path = "index.html" if norm == "" else norm
        # Reject paths that belong to the other origin, as a real split would.
        if self.is_asset:
            if not any(path.startswith(p) for p in ASSET_PREFIXES):
                self.send_error(404, "not on this origin")
                return
        else:
            if any(path.startswith(p) for p in APP_FORBIDDEN):
                self.send_error(404, "not on this origin")
                return
        full = os.path.realpath(os.path.join(ROOT, path))
        if not (full == ROOT or full.startswith(ROOT + os.sep)) or not os.path.isfile(full):
            self.send_error(404)
            return

        # Mimic the production bucket: empty chunks are not stored, so they 404.
        if Handler.omit_empty and path.startswith("images/debian-chunks/chunk-"):
            name = os.path.basename(path)
            if REAL_CHUNKS is not None and name not in REAL_CHUNKS:
                self.send_error(404, "not stored")
                return

        ext = os.path.splitext(full)[1].lower()
        data = open(full, "rb").read()
        total = len(data)
        range_hdr = self.headers.get("Range")
        status = 200
        out = data
        content_range = None
        if range_hdr and range_hdr.startswith("bytes="):
            spec = range_hdr[6:].split(",")[0].strip()
            parts = spec.split("-")
            if len(parts) == 2 and parts[0].isdigit():
                start = int(parts[0])
                end = int(parts[1]) if parts[1].isdigit() else total - 1
                end = min(end, total - 1)
                if 0 <= start <= end < total:
                    status = 206
                    out = data[start:end + 1]
                    content_range = f"bytes {start}-{end}/{total}"

        self.send_response(status)
        self.send_header("Content-Type", CT.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Accept-Ranges", "bytes")
        if content_range:
            self.send_header("Content-Range", content_range)

        if self.cache_headers:
            # Chunk, bundle, and pack files are cached cleanly.
            if "debian-chunks/" in path or "debian-bundles/" in path or path.startswith("bundles/") or path.startswith("packs/"):
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
                self.send_header("Cache-Control", "no-cache")

        if self.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Range, If-None-Match, If-Modified-Since")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag")

        self.end_headers()
        if body != "HEAD":
            self.wfile.write(out)

    def do_OPTIONS(self):
        self.send_response(204)
        if self.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Range, If-None-Match, If-Modified-Since")
            self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        self._serve("GET")

    def do_HEAD(self):
        self._serve("HEAD")


def serve(port, is_asset, cors, cache_headers):
    cls = type("H", (Handler,), {"is_asset": is_asset, "cors": cors,
                                 "cache_headers": cache_headers})
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), cls) as httpd:
        httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cors", action="store_true", help="omit CORS headers (negative test)")
    ap.add_argument("--no-cache-headers", action="store_true")
    ap.add_argument("--omit-empty-chunks", action="store_true",
                    help="404 the empty chunks, as the production bucket does")
    args = ap.parse_args()

    global REAL_CHUNKS
    if args.omit_empty_chunks:
        REAL_CHUNKS = load_real_chunks()
        Handler.omit_empty = True
        print(f"omitting empty chunks; {len(REAL_CHUNKS or [])} real chunks stored")

    t1 = threading.Thread(target=serve,
                          args=(8090, False, False, not args.no_cache_headers),
                          daemon=True)
    t2 = threading.Thread(target=serve,
                          args=(8091, True, not args.no_cors,
                                not args.no_cache_headers),
                          daemon=True)
    t1.start()
    t2.start()
    print("app   : http://127.0.0.1:8090/index.html")
    print("assets: http://127.0.0.1:8091/images/debian-chunks/")
    print(f"cors={'on' if not args.no_cors else 'OFF'}  cache_headers={'on' if not args.no_cache_headers else 'OFF'}")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
