/* THE single place for cache names, feature flags, shell manifest, and asset URLs.
 *
 * Loaded by index.html (<script>) and sw.js (importScripts), so the two can
 * never drift. Bump GL_VERSION on every deploy so returning clients refresh
 * their caches cleanly.
 *
 * Asset layout in production:
 *   app origin   : index.html, styles.css, js/*, wasm, BIOS, kernel, initrd, snapshot
 *   asset origin : disk chunks and offline packs (Cloudflare R2 + custom domain)
 *
 * Set GL_ASSET_ORIGIN to "" to serve everything from one origin (local dev with
 * a single server, or a fully self-hosted deploy).
 */
const GL_VERSION = "v19";

/* Snapshot/device schema version. Increment whenever v86 device topology
 * (e.g. virtio_console, memory_size) changes so incompatible saved OPFS states
 * are never restored against a mismatched device list. */
const GL_STATE_SCHEMA = 2;

/* Guest RAM in bytes. Must match tools/image/build-snapshot.sh (MEM_MB=256). */
const GL_MEMORY_SIZE = 256 * 1024 * 1024;

/* Launch feature flags. Unstable/non-core features stay off until their tests
 * and invariants pass (see docs/stabilization/SCOPE.md). */
const GL_FEATURES = Object.freeze({
  packs: false,
  diskIndicator: true,   // compact floating toast (zero terminal layout shift)
  toolProgress: false,
  prefetch: false,
  upload: true,          // 9p create_file() into /mnt/host (zero stdin injection)
  download: true,        // /mnt/host file browser using 9p read_file() (zero stdin injection)
  restartButton: true,   // safe snapshot restart (re-instantiates V86; never SeaBIOS reboot)
});

/* Authoritative app-shell file list, shared by sw.js (precache) and
 * tools/deploy/build-pages.sh (staging). */
const GL_SHELL_FILES = Object.freeze([
  "./",
  "index.html",
  "terminal.html",
  "landing.css",
  "styles.css",
  "about.html",
  "manifest.json",
  "packs-config.js",
  "packs.js",
  "persist.js",
  "persist-9p.js",
  "js/landing.js",
  "js/main.js",
  "js/status.js",
  "js/boot.js",
  "js/terminal.js",
  "js/keybar.js",
  "js/persist-ui.js",
  "js/packs-ui.js",
  "js/transfer.js",
  "js/tool-progress.js",
  "assets/v86/libv86.js",
  "assets/v86/v86.wasm",
  "assets/v86/v86-fallback.wasm",
  "assets/xterm/xterm.js",
  "assets/xterm/xterm.css",
  "assets/bios/seabios.bin",
  "assets/bios/vgabios.bin",
  "images/debian-bzImage",
  "images/debian-initrd",
  "assets/empty-chunk.zst",
  "chunks-precache.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
]);

/* Where chunks and packs live.
 * Empty string = same origin. In production put the R2 custom domain here,
 * e.g. "https://assets.golinux.app" (no trailing slash). */
const GL_ASSET_ORIGIN = "https://assets.golinux.app";

/* localStorage key for a LOCAL-only ?assets= override. Host-guarded on BOTH
 * write and read (and inside sw.js), so it can never affect production. */
const GL_LOCAL_OVERRIDE_KEY = "golinux.assets.override";

/** True only on loopback hosts used for local development / testing. */
function glIsLocalHost(hostname) {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname || "");
}

/* Resolved at load time; everything else must use this, not the raw constant. */
let GL_ASSET_BASE = (function () {
  try {
    const isLocal = typeof location !== "undefined" && glIsLocalHost(location.hostname);
    if (isLocal) {
      if (location.search) {
        const q = new URLSearchParams(location.search).get("assets");
        if (q) {
          const base = q.replace(/\/+$/, "");
          try { localStorage.setItem(GL_LOCAL_OVERRIDE_KEY, base); } catch (e) {}
          return base;
        }
      }
      const saved = localStorage.getItem(GL_LOCAL_OVERRIDE_KEY);
      if (saved) return saved.replace(/\/+$/, "");
    }
  } catch (e) { /* not a page context */ }
  return (GL_ASSET_ORIGIN || "").replace(/\/+$/, "");
})();

/** Called in the worker context to apply a localhost-only ?assets= override. */
function glSetAssetBase(base) {
  GL_ASSET_BASE = (base || "").replace(/\/+$/, "");
  return GL_ASSET_BASE;
}

const GL_SHELL_CACHE = `golinux-shell-${GL_VERSION}`;
const GL_DATA_CACHE = `golinux-data-${GL_VERSION}`;   // snapshot + on-demand chunks
const GL_PACK_CACHE = `golinux-pack-${GL_VERSION}`;   // opt-in chunk packs

/* Same-origin paths (shell). */
const GL_SNAPSHOT_URL = "images/debian-state.bin.zst";
const GL_BUILD_ID_URL = "images/build-id.json";

/* BUILD-ID VERSIONED CHUNK PATH.
 * Stamped into the staged copy at deploy time by tools/deploy/build-pages.sh.
 * Empty in source means local dev flat paths. */
const GL_BUILD_ID = "";

const GL_CHUNK_PATH = GL_BUILD_ID
  ? `images/debian-chunks/${GL_BUILD_ID}/`
  : "images/debian-chunks/";

/* The zeroed chunk used as the 404 / offline fallback for known-empty chunks. */
const GL_EMPTY_CHUNK_PATH = "assets/empty-chunk.zst";
const GL_PACKS_PATH = GL_BUILD_ID ? `packs/${GL_BUILD_ID}/` : "packs/";

/** Full URL for a chunk filename. */
function glChunkUrl(name) {
  return GL_ASSET_BASE + "/" + GL_CHUNK_PATH + name;
}

/** Full URL for a pack list or the pack index. */
function glPackUrl(file) {
  return GL_ASSET_BASE + "/" + GL_PACKS_PATH + file;
}

/** True if this URL points at a chunk we serve from the asset origin. */
function glIsChunkUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.pathname.includes("/" + GL_CHUNK_PATH) &&
           /chunk-\d+-\d+\.zst$/.test(u.pathname);
  } catch (e) {
    return false;
  }
}

/* ---------- prefetch tuning (inactive while GL_FEATURES.prefetch === false) ---------- */
const GL_PREFETCH = GL_FEATURES.prefetch;
const GL_PREFETCH_MIN_BPS = 1.5 * 1024 * 1024;
const GL_PREFETCH_CONCURRENCY = 4;
const GL_PREFETCH_CAP_BYTES = 16 * 1024 * 1024;
