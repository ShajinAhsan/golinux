#!/usr/bin/env node
// Upload hybrid chunk bundles (bundles/<buildId>/*.pack) and pack manifests
// (packs/<buildId>/*.json) to Cloudflare R2 using `wrangler r2 object put --remote`.
//
// Because bundling reduces ~5,600+ chunk objects down to ~300-400 .pack files,
// parallel wrangler uploads finish in under a minute using your existing
// `wrangler login` session — no separate S3/R2 API keys required.
//
// Usage:
//   node tools/deploy/upload-bundles-r2.js [--bucket golinux-assets] [--concurrency 12] [--dry-run]
'use strict';

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BUCKET = argVal("--bucket", process.env.R2_BUCKET || "golinux-assets");
const CONCURRENCY = Math.max(1, Math.min(24, Number(argVal("--concurrency", "10")) || 10));

function findWranglerBin() {
  const local = path.join(ROOT, "node_modules", ".bin", "wrangler");
  if (fs.existsSync(local)) return [local, []];
  return ["npx", ["wrangler"]];
}

function runPut(bin, baseArgs, job) {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      ...baseArgs,
      "r2", "object", "put", `${BUCKET}/${job.key}`,
      "--remote",
      "--file", job.file,
      "--content-type", job.contentType,
      "--cache-control", job.cacheControl,
    ];
    const p = spawn(bin, cliArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    p.stderr.on("data", (d) => { errText += d; });
    p.stdout.on("data", (d) => { errText += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`put ${job.key} failed (exit ${code}): ${errText.slice(-300)}`));
    });
  });
}

async function runWithRetry(bin, baseArgs, job, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await runPut(bin, baseArgs, job);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

(async () => {
  const buildId = JSON.parse(
    fs.readFileSync(path.join(ROOT, "images", "build-id.json"), "utf8")
  ).buildId;
  if (!buildId) throw new Error("images/build-id.json has empty buildId");

  const bundlesDir = path.join(ROOT, "images", "debian-bundles", buildId);
  if (!fs.existsSync(bundlesDir)) {
    throw new Error(`missing ${bundlesDir}; run: node tools/image/build-bundles.js`);
  }

  const jobs = [];
  for (const f of fs.readdirSync(bundlesDir).sort()) {
    if (!f.endsWith(".pack")) continue;
    jobs.push({
      key: `bundles/${buildId}/${f}`,
      file: path.join(bundlesDir, f),
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
  }

  const packsDir = path.join(ROOT, "packs");
  for (const f of fs.readdirSync(packsDir).sort()) {
    if (!f.endsWith(".json")) continue;
    jobs.push({
      key: `packs/${buildId}/${f}`,
      file: path.join(packsDir, f),
      contentType: "application/json",
      cacheControl: "public, max-age=3600, must-revalidate",
    });
  }

  const totalBytes = jobs.reduce((s, j) => s + fs.statSync(j.file).size, 0);
  console.log(
    `R2 upload plan: bucket=${BUCKET}, buildId=${buildId}, ` +
    `${jobs.length} objects (${(totalBytes / 1048576).toFixed(1)} MB), concurrency=${CONCURRENCY}`
  );

  if (DRY_RUN) {
    console.log("DRY RUN: nothing uploaded.");
    return;
  }

  const [bin, baseArgs] = findWranglerBin();
  let next = 0;
  let done = 0;
  const started = Date.now();

  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= jobs.length) return;
      await runWithRetry(bin, baseArgs, jobs[idx]);
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  uploaded ${done}/${jobs.length} (${secs}s)`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Done: uploaded ${done} objects to ${BUCKET} for build ${buildId}.`);
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
