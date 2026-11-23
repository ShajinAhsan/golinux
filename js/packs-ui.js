/* Offline packs dialog UI (only active when GL_FEATURES.packs === true).
 *
 * Fixes:
 *   - BUG-19: dead "golinux-packs-ui" BroadcastChannel removed (GoPacks.onUpdate drives UI).
 *   - BUG-20: removePack()/useMinimal() now await cancel cleanly inside GoPacks.
 *   - BUG-21: fixes "Removed null pack", disables Save while already saved/running,
 *             and clarifies when Common is already included in Full.
 */

import { fmtBytes } from "./status.js";

function networkSaysFrugal() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return /^(slow-2g|2g|3g)$/.test(c.effectiveType || "");
}

function packLabel(id, st, allStates) {
  if (!st) return "…";
  if (id === "common" && allStates && allStates.full && allStates.full.complete) {
    return "included in Full";
  }
  if (st.total && st.complete) return "saved";
  if (st.present > 0) return `${st.present} of ${st.total} saved (resume)`;
  return "not saved";
}

function packSizes(states, manifest) {
  let bytes = 0;
  for (const id of ["common", "full"]) {
    const st = states[id];
    const info = manifest[id];
    if (st && st.total && info) bytes = Math.max(bytes, info.bytes * (st.present / st.total));
  }
  return bytes;
}

export function setupPacksUI() {
  if (!GL_FEATURES.packs || !window.GoPacks) return;

  const packsEl = document.getElementById("packs");
  const packStatusEl = document.getElementById("packStatus");
  const packProgressEl = document.getElementById("packProgress");
  const packProgressFill = document.getElementById("packProgressFill");
  const packProgressPct = document.getElementById("packProgressPct");
  const packProgressLabel = document.getElementById("packProgressLabel");
  const packPauseBtn = document.getElementById("packPause");
  const packCancelBtn = document.getElementById("packCancel");
  const openBtn = document.getElementById("openPacks");
  const closeBtn = document.getElementById("closePacks");

  let packManifest = {};

  async function showQuota() {
    const el = document.getElementById("packQuota");
    if (!el) return;
    try {
      const est = await navigator.storage.estimate();
      el.textContent = `using ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} available`;
    } catch (e) {
      el.textContent = "";
    }
  }

  function renderPacks(states) {
    states = states || {};
    const running = window.GoPacks.getJob ? window.GoPacks.getJob() : null;
    const busy = !!running;

    for (const id of ["minimal", "common", "full"]) {
      const sizeEl = document.querySelector(`[data-size="${id}"]`);
      const badgeEl = document.querySelector(`[data-badge="${id}"]`);
      const row = document.querySelector(`.pack[data-pack="${id}"]`);
      const info = packManifest[id];
      const st = states[id];

      if (sizeEl && info) {
        sizeEl.textContent = id === "minimal"
          ? fmtBytes(info.totalBytes)
          : `${fmtBytes(info.bytes)} · ${fmtBytes(info.totalBytes)} total`;
      }
      if (badgeEl) {
        badgeEl.textContent = id === "minimal" ? "" : "· " + packLabel(id, st, states);
      }
      if (row) row.classList.toggle("installed", !!(st && st.complete));

      const isRunningPack = busy && running.packId === id;
      const saveBtn = document.querySelector(`[data-install="${id}"]`);
      const remBtn = document.querySelector(`[data-remove="${id}"]`);

      if (saveBtn) {
        if (id === "minimal") {
          saveBtn.disabled = busy && !isRunningPack;
          saveBtn.textContent = "Use";
        } else {
          const alreadyDone = !!(st && st.complete);
          saveBtn.disabled = busy || alreadyDone;
          saveBtn.textContent = alreadyDone ? "Saved" : (st && st.present > 0 ? "Resume" : "Save");
        }
      }
      if (remBtn) {
        const coveredByFull = id === "common" && states.full && states.full.complete;
        remBtn.disabled = (busy && !isRunningPack) || coveredByFull;
        remBtn.textContent = (isRunningPack && running.kind === "download") ? "Cancel" : "Remove";
      }
    }

    const frugalEl = document.getElementById("saveDataNote");
    if (frugalEl) frugalEl.classList.toggle("visible", networkSaysFrugal());
    showQuota();
  }

  function renderPackProgress(s) {
    const j = s && s.job;
    if (!j) {
      packProgressEl.classList.remove("visible");
      return;
    }
    packProgressEl.classList.add("visible");
    const pct = j.total ? (j.done / j.total) * 100 : 0;
    packProgressFill.style.width = pct.toFixed(1) + "%";
    const verb = j.paused ? "Paused" : (j.kind === "download" ? "Downloading" : "Removing");
    packProgressLabel.textContent = `${verb} ${j.packId} pack`;
    packProgressPct.textContent = `${j.done}/${j.total} · ${fmtBytes(j.loaded)}`;
    packPauseBtn.textContent = j.paused ? "Resume" : "Pause";
    packPauseBtn.disabled = j.kind !== "download";
  }

  window.GoPacks.onUpdate((s) => {
    renderPackProgress(s);
    renderPacks(s.states);
  });

  if (openBtn) {
    openBtn.onclick = async () => {
      packsEl.classList.add("visible");
      packManifest = await window.GoPacks.loadManifest();
      renderPacks(await window.GoPacks.packStates());
    };
  }
  if (closeBtn) closeBtn.onclick = () => packsEl.classList.remove("visible");
  packsEl.addEventListener("click", (e) => {
    if (e.target === packsEl) packsEl.classList.remove("visible");
  });

  packsEl.addEventListener("click", async (e) => {
    const t = e.target.closest && e.target.closest("button");
    if (!t || t.disabled) return;
    const installId = t.getAttribute("data-install");
    const removeId = t.getAttribute("data-remove");
    if (!installId && !removeId) return;

    packStatusEl.textContent = "";
    let result;
    const wasMinimal = installId === "minimal";

    if (wasMinimal) {
      const states = await window.GoPacks.packStates();
      const anySaved = (states.common && states.common.present > 0) ||
                       (states.full && states.full.present > 0);
      if (!anySaved && !window.GoPacks.getJob()) {
        packStatusEl.textContent = "Minimal is already in use.";
        return;
      }
      const size = fmtBytes(packSizes(states, packManifest));
      if (!window.confirm("This removes the saved packs" + (size ? " (" + size + ")" : "") + ". Continue?")) {
        packStatusEl.textContent = "Cancelled.";
        return;
      }
      result = await window.GoPacks.useMinimal();
    } else if (installId) {
      result = await window.GoPacks.install(installId);
    } else {
      result = await window.GoPacks.removePack(removeId);
    }

    if (result && result.refused) packStatusEl.textContent = result.reason;
    else if (result && result.error) packStatusEl.textContent = "Failed: " + result.error;
    else if (result && result.cancelled) packStatusEl.textContent = result.reason;
    else if (result && result.incomplete) packStatusEl.textContent = result.reason;
    else if (result && result.complete) packStatusEl.textContent = "Saved " + installId + " pack.";
    else if (result && typeof result.deleted === "number") {
      packStatusEl.textContent = wasMinimal
        ? `Removed all saved pack chunks (${result.deleted} chunks).`
        : `Removed ${removeId} pack (${result.deleted} chunks; shared chunks kept).`;
    }
    renderPacks(await window.GoPacks.packStates());
  });

  if (packPauseBtn) {
    packPauseBtn.onclick = () => {
      const j = window.GoPacks.getJob();
      if (!j) return;
      if (j.paused) window.GoPacks.resume();
      else window.GoPacks.pause();
    };
  }
  if (packCancelBtn) {
    packCancelBtn.onclick = () => {
      if (!window.GoPacks.cancel()) packStatusEl.textContent = "Nothing to cancel.";
    };
  }
}
