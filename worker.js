// Cloudflare Worker router for GoLinux multi-subdomain static assets.
//
// Routing:
//   terminal.golinux.app  / or /index.html  -> serves /terminal.html
//   golinux.app           / or /index.html  -> serves /index.html (landing page)
//   www.golinux.app       / or /index.html  -> serves /index.html (landing page)
//   golinux.app           /terminal         -> 302 https://terminal.golinux.app/
//   www.golinux.app       /terminal         -> 302 https://terminal.golinux.app/
//   Unknown routes                          -> /404.html with HTTP 404 + text/html
//   Everything else                         -> env.ASSETS.fetch(request)
//
// Static assets (JS, CSS, WASM, BIOS, kernel, initrd, snapshot, icons) bypass
// this Worker via wrangler.jsonc `assets.run_worker_first` when they exist,
// and missing paths fall through to `assets.not_found_handling: "404-page"`
// or this Worker's 404 HTML fallback so browsers never download an empty file.

const TERMINAL_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://assets.golinux.app https://cloudflare-dns.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function withHtmlHeaders(res, { status, statusText, headOnly = false, csp = "" } = {}) {
  const headers = new Headers(res.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (csp) headers.set("Content-Security-Policy", csp);
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(headOnly ? null : res.body, {
    status: status ?? res.status,
    statusText: statusText ?? res.statusText,
    headers,
  });
}

async function serveNotFound(request, env, url) {
  const headOnly = request.method === "HEAD";
  const notFoundUrl = new URL("/404.html", url);
  const res = await env.ASSETS.fetch(
    new Request(notFoundUrl, { method: headOnly ? "HEAD" : "GET" }),
  );
  if (res.ok) {
    return withHtmlHeaders(res, {
      status: 404,
      statusText: "Not Found",
      headOnly,
    });
  }
  return new Response(headOnly ? null : "Not Found", {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

async function fetchAssetOrNotFound(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      return withHtmlHeaders(res, {
        status: 404,
        statusText: "Not Found",
        headOnly: request.method === "HEAD",
      });
    }
    return serveNotFound(request, env, url);
  }
  return res;
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();
      const path = url.pathname;
      const headOnly = request.method === "HEAD";

      if (host === "terminal.golinux.app") {
        if (path === "/" || path === "/index.html" || path === "/terminal" || path === "/terminal/" || path === "/terminal.html") {
          const assetUrl = new URL("/terminal.html", url);
          const res = await env.ASSETS.fetch(new Request(assetUrl, { method: headOnly ? "HEAD" : "GET" }));
          return withHtmlHeaders(res, { headOnly, csp: TERMINAL_CSP });
        }
        return fetchAssetOrNotFound(request, env, url);
      }

      if (
        (host === "golinux.app" || host === "www.golinux.app") &&
        (path === "/terminal" || path === "/terminal/")
      ) {
        return Response.redirect("https://terminal.golinux.app/", 302);
      }

      if (path === "/" || path === "/index.html") {
        const assetUrl = new URL("/index.html", url);
        const res = await env.ASSETS.fetch(new Request(assetUrl, { method: headOnly ? "HEAD" : "GET" }));
        return withHtmlHeaders(res, { headOnly });
      }

      if (path === "/terminal.html") {
        const assetUrl = new URL("/terminal.html", url);
        const res = await env.ASSETS.fetch(new Request(assetUrl, { method: headOnly ? "HEAD" : "GET" }));
        return withHtmlHeaders(res, { headOnly, csp: TERMINAL_CSP });
      }

      if (path === "/about" || path === "/about/" || path === "/about.html") {
        const assetUrl = new URL("/about.html", url);
        const res = await env.ASSETS.fetch(new Request(assetUrl, { method: headOnly ? "HEAD" : "GET" }));
        return withHtmlHeaders(res, { headOnly });
      }

      return fetchAssetOrNotFound(request, env, url);
    } catch (_err) {
      return new Response(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>500 — GoLinux</title></head><body><h1>500 — Internal Error</h1><p>Something went wrong. <a href=\"/\">Return home</a>.</p></body></html>",
        {
          status: 500,
          statusText: "Internal Server Error",
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        },
      );
    }
  },
};
