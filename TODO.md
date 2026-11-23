# TODO

## After launch

- [ ] **Content-hash the pack file names** — `packs/<buildId>/common.<sha8>.json`
      (and likewise `full`, `tools`), with `index.json` naming the current hash
      for each. Today pack names carry only the build id, which comes from the
      *disk image*, so re-recording packs without an image change produces new
      bytes at the *same* URL and the CDN/browsers can keep serving the stale
      list. Hashing the file name makes the URL change whenever the content does.
      Touch points: `tools/image/build-pack-index.js` (emit hashed names),
      `tools/deploy/upload-r2.sh` (upload under the hashed name),
      `packs.js` and `index.html` (fetch the name from `index.json`).

      **Interim rule until this is done:** after re-recording packs, re-upload
      them with `./tools/deploy/upload-r2.sh` **and** bump `GL_VERSION` in
      `packs-config.js`. The version bump changes the shell/pack cache names, so
      clients stop reusing the old cached pack entries.
