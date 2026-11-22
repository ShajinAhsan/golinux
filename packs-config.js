/* THE single place for cache names and asset base URLs.
 *
 * Loaded by index.html (<script>) and sw.js (importScripts), so the two can
 * never drift. Bump GL_VERSION to invalidate every cached thing at once.
 *
 * Asset layout in production:
 *   app origin   : index.html, JS, CSS, wasm, BIOS, kernel, initrd, snapshot
 *   asset origin : disk chunks and offline packs (Cloudflare R2 + custom domain)
 *
 * Set GL_ASSET_ORIGIN to "" to serve everything from one origin (local dev with
 * a single server, or a fully self-hosted deploy).
 */
const GL_VERSION = "v13";

/* Where chunks and packs live.
 * Empty string = same origin. In production put the R2 custom domain here,
 * e.g. "https://assets.example.com" (no trailing slash).
 *
 * It can also be overridden per-load with ?assets=https://... which is what the
 * two-origin test harness uses. */
const GL_ASSET_ORIGIN = "";

/* Resolved at load time; everything else must use this, not the raw constant.
 *
 * A service worker has no ?assets= query of its own, so in a worker the value
 * comes from the override the page pushes with postMessage (see persist of
 * setAssetBase below). The page sets it before the worker needs it. */
let GL_ASSET_BASE = (function () {
  try {
    if (typeof location !== "undefined" && location.search) {
      const q = new URLSearchParams(location.search).get("assets");
      if (q) return q.replace(/\/+$/, "");
    }
  } catch (e) { /* not a page context */ }
  return (GL_ASSET_ORIGIN || "").replace(/\/+$/, "");
})();

/** Called by the page in the worker context to apply the ?assets= override. */
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

/* Asset paths.
 *
 * The PAGE must always request these from its own origin. v86's use_parts
 * implementation derives each part filename by splitting the URL string on the
 * LAST DOT:
 *     const parts = filename.match(/\.[^\.]+(\.zst)?$/);
 *     basename = filename.substring(0, filename.length - parts[0].length)
 * With a full absolute URL that regex matches inside the HOSTNAME, so
 *   http://127.0.0.1:8091/images/debian-chunks/chunk.zst
 * becomes
 *   http://127.0.0-0-131072.1:8091/images/debian-chunks/chunk.zst
 * and every chunk 404s, hanging the guest (v86 only retries 5xx, never 404).
 * So chunk URLs stay relative, and the service worker proxies them to
 * GL_ASSET_BASE. That keeps cross-origin hosting working.
 */
/* BUILD-ID VERSIONED CHUNK PATH.
 *
 * Chunk filenames are purely positional (chunk-<start>-<end>.zst), so a rebuild
 * produces the SAME names with DIFFERENT bytes. Serving those under
 * "Cache-Control: immutable" is a promise the bytes never change; after a
 * rebuild the CDN and browsers would keep handing out the previous build's
 * chunks, which silently corrupts the guest (observed offline as
 * "invalid ELF header").
 *
 * Putting a content-hash build id in the path makes every build's URLs unique,
 * so `immutable` becomes true and old builds keep working for users who are
 * mid-session.
 *
 * GL_BUILD_ID is written into this file at deploy time by
 * tools/deploy/stamp-build-id.sh (the value comes from images/build-id.json).
 * Empty means "unversioned", which is what local dev uses.
 */
const GL_BUILD_ID = "";

const GL_CHUNK_PATH = GL_BUILD_ID
  ? `images/debian-chunks/${GL_BUILD_ID}/`
  : "images/debian-chunks/";
/* The zeroed chunk used as the offline/404 fallback. It lives at the app origin,
 * outside the chunk directory, because it is a shell asset: it is precached with
 * the app and Pages does not serve images/debian-chunks/. */
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

// localStorage key remembering which pack is installed.
const GL_PACK_KEY = "golinux.pack";
