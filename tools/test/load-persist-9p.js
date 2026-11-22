/**
 * Load persist-9p.js into a non-browser context (Node, for tests).
 *
 * persist-9p.js is an IIFE that attaches to `window`. In Node there is no
 * window, so evaluate it with a minimal shim to get the same code under test
 * that the browser runs - not a reimplementation.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadPersist9p(target) {
  const file = path.join(__dirname, "..", "..", "persist-9p.js");
  const src = fs.readFileSync(file, "utf8");
  const win = target || {};

  // Minimal window shim: the module only reads/writes window.Go9p and
  // optionally window.__lastStrippedBytes.
  const runner = new Function("window", "console", src + "\nreturn window.Go9p;");
  const api = runner(win, console);
  if (!api) throw new Error("persist-9p.js did not export Go9p");
  return api;
}

module.exports = { loadPersist9p };
