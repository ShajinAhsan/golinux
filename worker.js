// Cloudflare Worker router for GoLinux multi-subdomain static assets.
//
// Routing:
//   terminal.golinux.app  / or /index.html  -> serves /terminal.html
//   golinux.app           / or /index.html  -> serves /index.html (landing page)
//   www.golinux.app       / or /index.html  -> serves /index.html (landing page)
//   golinux.app           /terminal         -> 302 https://terminal.golinux.app/
//   www.golinux.app       /terminal         -> 302 https://terminal.golinux.app/
//   Everything else                         -> env.ASSETS.fetch(request)
//
// Static assets (JS, CSS, WASM, BIOS, kernel, initrd, snapshot, icons) bypass
// this Worker via wrangler.jsonc `assets.run_worker_first` so they are served
// straight from Cloudflare's edge asset store with zero Worker CPU overhead.

function withHtmlHeaders(res) {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    if (host === "terminal.golinux.app") {
      if (path === "/" || path === "/index.html") {
        const assetUrl = new URL("/terminal.html", url);
        const res = await env.ASSETS.fetch(new Request(assetUrl, request));
        return withHtmlHeaders(res);
      }
      return env.ASSETS.fetch(request);
    }

    if (
      (host === "golinux.app" || host === "www.golinux.app") &&
      (path === "/terminal" || path === "/terminal/")
    ) {
      return Response.redirect("https://terminal.golinux.app/", 302);
    }

    if (path === "/" || path === "/index.html") {
      const assetUrl = new URL("/index.html", url);
      const res = await env.ASSETS.fetch(new Request(assetUrl, request));
      return withHtmlHeaders(res);
    }

    return env.ASSETS.fetch(request);
  },
};
