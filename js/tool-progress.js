/* Per-tool disk progress, instant unique-chunk matching, and active-tool
 * pipelining for slow connections.
 *
 * Exports pure matchTool(names, toolSets) for Layer-1 unit tests, plus
 * loadToolSets() and cachedChunkNameSet() for the Tools & Cache drawer and
 * background idle pre-warmer.
 */

import { fmtBytes, fmtEta, fmtSpeed, mb, setDiskLabelProvider } from "./status.js";

/** Tools already warm in the shipped Alpine snapshot RAM (0 disk chunks). */
export const INSTANT_TOOLS = Object.freeze([
  { id: "vi", title: "vi" },
  { id: "cowsay", title: "cowsay" },
  { id: "sl", title: "sl" },
]);

/**
 * Identify the active tool from observed chunk names.
 *
 * Strategy:
 *   1. Standard most-specific hypothesis when >= 2 chunks match any tool
 *      (handles shared libraries accurately).
 *   2. Instant 1-chunk match when a chunk uniquely belongs to EXACTLY ONE
 *      tool in toolSets (e.g. python3/git/curl/nano binary chunks) so slow
 *      connections identify the active tool on the very first read.
 */
export function matchTool(names, toolSets) {
  if (!toolSets || !names || !names.length) return null;
  const entries = Object.entries(toolSets);
  if (!entries.length) return null;

  const hits = new Map();
  for (const [id, s] of entries) {
    let h = 0;
    for (const n of names) if (s.names.has(n)) h++;
    if (h >= 2) hits.set(id, h);
  }
  const candidates = [...hits.entries()];
  if (candidates.length) {
    const maxHit = Math.max(...candidates.map(([, h]) => h));
    const kept = candidates.filter(([, h]) => h >= maxHit * 0.5);
    kept.sort((a, b) => toolSets[a[0]].list.length - toolSets[b[0]].list.length);
    return kept[0][0];
  }

  // Fallback: single unique-owner chunk identifies the tool immediately.
  for (const n of names) {
    let owner = null;
    let count = 0;
    for (const [id, s] of entries) {
      if (s.names.has(n)) {
        owner = id;
        count++;
        if (count > 1) break;
      }
    }
    if (count === 1 && owner) return owner;
  }
  return null;
}

let toolSets = null;
let toolSetsInFlight = null;
let activeTool = null;
let toolTotal = 0;
let toolCachedCount = 0;
let toolCounted = new Set();
let toolPipelined = new Set();
let recentBurstNames = [];

export async function loadToolSets() {
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

export async function cachedChunkNameSet() {
  const have = new Set();
  if (typeof caches === "undefined") return have;
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

function pipelineNextToolChunks(toolId) {
  if (!toolSets || !toolSets[toolId]) return;
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  const list = toolSets[toolId].list;
  const next = [];
  for (const ch of list) {
    if (toolCounted.has(ch) || toolPipelined.has(ch)) continue;
    next.push(ch);
    toolPipelined.add(ch);
    if (next.length >= 2) break;
  }
  if (next.length) {
    navigator.serviceWorker.controller.postMessage({
      type: "warm-chunks",
      priority: "tool",
      names: next,
    });
  }
}

export function setupToolProgress() {
  if (!GL_FEATURES.toolProgress && !GL_FEATURES.prefetch) {
    return { onNames: null, onBurstEnd: null };
  }

  loadToolSets();

  setDiskLabelProvider((state) => {
    if (!activeTool || !toolSets || !toolSets[activeTool]) return null;
    const s = toolSets[activeTool];
    const frac = toolTotal ? (toolCachedCount / toolTotal) : 0;
    const estDone = Math.min(s.bytes, s.bytes * frac + (state ? state.inflightBytes || 0 : 0));
    const pct = s.bytes > 0 ? Math.min(99, (estDone / s.bytes) * 100) : (frac * 100);
    const totalStr = s.bytes >= 1048576 ? `${mb(s.bytes)} MB` : fmtBytes(s.bytes);
    const doneStr = s.bytes >= 1048576 ? `${mb(estDone)}` : fmtBytes(estDone);
    const sub = s.bytes >= 1048576 ? `${doneStr} / ${totalStr}` : `${doneStr || "0 KB"} / ${totalStr}`;

    let meta = "";
    const bps = state && state.bps;
    const elapsedMs = state ? state.elapsedMs : 0;
    if (elapsedMs >= 900 || (state && state.mode === "slow")) {
      const bits = [];
      if (bps > 0) {
        bits.push(fmtSpeed(bps));
        const remBytes = Math.max(0, s.bytes - estDone);
        if (remBytes > 4096) {
          const eta = fmtEta(remBytes / bps);
          if (eta) bits.push(eta);
        }
      }
      bits.push("cached after first run");
      meta = bits.join(" · ");
    }

    return {
      label: `Loading ${s.title}…`,
      sub,
      pct,
      meta,
    };
  });

  return {
    onNames(completedNames, activeNames) {
      const doneList = Array.isArray(completedNames) ? completedNames : [];
      const activeList = Array.isArray(activeNames) ? activeNames : [];
      for (const n of activeList) {
        if (!recentBurstNames.includes(n) && recentBurstNames.length < 128) recentBurstNames.push(n);
      }
      for (const n of doneList) {
        if (!recentBurstNames.includes(n) && recentBurstNames.length < 128) recentBurstNames.push(n);
      }

      const tool = matchTool(recentBurstNames, toolSets);
      if (!tool) return;

      if (tool !== activeTool) {
        activeTool = tool;
        toolTotal = toolSets[tool].list.length;
        toolCounted = new Set();
        toolPipelined = new Set();
        for (const n of doneList) {
          if (toolSets[tool].names.has(n)) toolCounted.add(n);
        }
        toolCachedCount = toolCounted.size;
        cachedChunkNameSet().then((have) => {
          if (activeTool !== tool) return;
          for (const n of toolSets[tool].list) {
            if (have.has(n)) toolCounted.add(n);
          }
          toolCachedCount = Math.min(toolTotal, toolCounted.size);
          pipelineNextToolChunks(tool);
        });
      } else {
        for (const n of doneList) {
          if (toolSets[tool].names.has(n)) toolCounted.add(n);
        }
        toolCachedCount = Math.min(toolTotal, toolCounted.size);
        pipelineNextToolChunks(tool);
      }
    },
    onBurstEnd() {
      activeTool = null;
      toolCounted = new Set();
      toolPipelined = new Set();
      toolCachedCount = 0;
      recentBurstNames = [];
    },
  };
}
