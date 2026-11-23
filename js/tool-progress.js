/* Optional per-tool disk progress & slow-link prefetch (flagged off by default).
 *
 * Fixes BUG-30:
 *   - Pure matchTool(names, sets) exported for unit testing.
 *   - loadToolSets() retries on transient failure (never caches null forever).
 *   - Replaces 708 sequential caches.open()+match() calls with ONE cache.keys() scan.
 */

import { setDiskLabelProvider } from "./status.js";

/** Most-specific-hypothesis tool matcher (pure, exported for unit tests). */
export function matchTool(names, toolSets) {
  if (!toolSets || !names || !names.length) return null;
  const hits = new Map();
  for (const [id, s] of Object.entries(toolSets)) {
    let h = 0;
    for (const n of names) if (s.names.has(n)) h++;
    if (h >= 2) hits.set(id, h);
  }
  const candidates = [...hits.entries()];
  if (!candidates.length) return null;

  const maxHit = Math.max(...candidates.map(([, h]) => h));
  const kept = candidates.filter(([, h]) => h >= maxHit * 0.5);
  kept.sort((a, b) => toolSets[a[0]].list.length - toolSets[b[0]].list.length);
  return kept[0][0];
}

let toolSets = null;
let toolSetsInFlight = null;
let activeTool = null;
let toolTotal = 0;
let toolCachedCount = 0;
let toolCounted = new Set();

async function loadToolSets() {
  if (toolSets) return toolSets;
  if (toolSetsInFlight) return toolSetsInFlight;
  toolSetsInFlight = (async () => {
    try {
      const r = await fetch(glPackUrl("tools.json"), { cache: "no-store" });
      if (!r.ok) return null;
      const raw = await r.json();
      const sets = {};
      for (const [id, v] of Object.entries(raw)) {
        if (!v || !Array.isArray(v.chunks)) continue;
        sets[id] = {
          title: v.title || id,
          bytes: v.bytes || 0,
          names: new Set(v.chunks),
          list: v.chunks,
        };
      }
      toolSets = sets;
      return sets;
    } catch (e) {
      return null;
    } finally {
      toolSetsInFlight = null;
    }
  })();
  return toolSetsInFlight;
}

async function cachedChunkNameSet() {
  const have = new Set();
  for (const cn of [GL_PACK_CACHE, GL_DATA_CACHE]) {
    try {
      const c = await caches.open(cn);
      for (const req of await c.keys()) {
        const name = new URL(req.url).pathname.split("/").pop();
        if (name) have.add(name);
      }
    } catch (e) { /* ignore */ }
  }
  return have;
}

export function setupToolProgress() {
  if (!GL_FEATURES.toolProgress && !GL_FEATURES.prefetch) {
    return { onNames: null, onBurstEnd: null };
  }

  loadToolSets();

  setDiskLabelProvider(() => {
    if (!activeTool || !toolSets || !toolSets[activeTool]) return null;
    const s = toolSets[activeTool];
    const frac = toolTotal ? toolCachedCount / toolTotal : 0;
    return {
      label: `Loading ${s.title}…`,
      sub: `${toolCachedCount}/${toolTotal} (${((s.bytes * frac) / 1048576).toFixed(1)} MB)`,
    };
  });

  return {
    onNames(names) {
      const tool = matchTool(names, toolSets);
      if (!tool) return;
      if (tool !== activeTool) {
        activeTool = tool;
        toolTotal = toolSets[tool].list.length;
        toolCounted = new Set();
        for (const n of names) {
          if (toolSets[tool].names.has(n)) toolCounted.add(n);
        }
        toolCachedCount = toolCounted.size;
        cachedChunkNameSet().then((have) => {
          if (activeTool !== tool) return;
          for (const n of toolSets[tool].list) {
            if (have.has(n)) toolCounted.add(n);
          }
          toolCachedCount = Math.min(toolTotal, toolCounted.size);
        });
      } else {
        for (const n of names) {
          if (toolSets[tool].names.has(n)) toolCounted.add(n);
        }
        toolCachedCount = Math.min(toolTotal, toolCounted.size);
      }
    },
    onBurstEnd() {
      activeTool = null;
      toolCounted = new Set();
      toolCachedCount = 0;
    },
  };
}
