/* Minimal, zero-dependency interactivity for GoLinux landing page.
 * Automatically pauses animations when off-screen or hidden to save battery/CPU. */
(function () {
  "use strict";

  // On localhost/127.0.0.1, route "Try GoLinux" buttons to local terminal.html;
  // in production they point to https://terminal.golinux.app.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (isLocal) {
    for (const a of document.querySelectorAll("[data-launch-url]")) {
      a.setAttribute("href", "terminal.html");
    }
  }

  /* ---------- Interactive "How does it work?" stepper ---------- */
  const CAPTIONS = [
    "Your browser starts a tiny virtual x86 PC using WebAssembly — nothing runs on a remote server.",
    "A ~13 MB pre-booted snapshot loads once into RAM, waking Debian at the shell prompt in under a second.",
    "When you run a command like gcc, only its 128 KB disk slices stream from Cloudflare R2 into your local cache.",
    "Files you save in /root persist privately in your browser's OPFS storage and survive reloads.",
  ];

  const svg = document.getElementById("archSvg");
  const stepTag = document.getElementById("howStepTag");
  const captionEl = document.getElementById("howCaption");
  const toggleBtn = document.getElementById("howToggle");
  const toggleLabel = document.getElementById("howToggleLabel");
  const stepBtns = Array.from(document.querySelectorAll(".how-step"));

  let currentStep = 0;
  let userPaused = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = true;
  let timer = null;

  function applyStep(idx) {
    currentStep = idx;
    if (svg) svg.setAttribute("data-active-step", String(idx));
    if (stepTag) stepTag.textContent = `Step ${idx + 1} of ${CAPTIONS.length}`;
    if (captionEl) captionEl.textContent = CAPTIONS[idx];
    stepBtns.forEach((b, i) => {
      const on = i === idx;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  function syncPlayback() {
    const running = !userPaused && visible && document.visibilityState === "visible";
    if (svg) svg.classList.toggle("paused", !running);
    if (toggleLabel) toggleLabel.textContent = userPaused ? "Play" : "Pause";
    if (toggleBtn) toggleBtn.setAttribute("aria-label", userPaused ? "Play animation" : "Pause animation");
    clearInterval(timer);
    timer = null;
    if (running) {
      timer = setInterval(() => applyStep((currentStep + 1) % CAPTIONS.length), 3600);
    }
  }

  stepBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      applyStep(idx);
      syncPlayback();
    });
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      userPaused = !userPaused;
      syncPlayback();
    });
  }

  if ("IntersectionObserver" in window && svg) {
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      syncPlayback();
    }, { threshold: 0.15 });
    io.observe(svg);
  }
  document.addEventListener("visibilitychange", syncPlayback);

  applyStep(0);
  syncPlayback();

  /* ---------- Interactive "What's inside" tool demos ---------- */
  const DEMOS = {
    gcc: {
      title: "gcc / g++ — Real GCC 12 C & C++ compiler",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> cat hello.c\n` +
        `<span class="c-c">#include &lt;stdio.h&gt;</span>\nint main(void) { puts("Hello from WASM!"); return 0; }\n\n` +
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> gcc -O2 hello.c -o hello &amp;&amp; ./hello\n` +
        `<span class="c-exec">Hello from WASM!</span>`,
    },
    git: {
      title: "git — Full local repositories, branches & diffs",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~/app</span><span class="t-muted">#</span> git init &amp;&amp; git add . &amp;&amp; git commit -m "init"\n` +
        `<span class="t-dim">[master (root-commit) 9a4f1c2] init\n 2 files changed, 18 insertions(+)</span>\n\n` +
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~/app</span><span class="t-muted">#</span> git log --oneline\n` +
        `<span class="c-warn">9a4f1c2</span> <span class="c-sym">(HEAD -&gt; master)</span> init`,
    },
    python3: {
      title: "python3 — Real Python 3.11 interpreter & standard library",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> python3 -c "import math, json; print(json.dumps({'pi': round(math.pi, 5)}))"\n` +
        `<span class="c-exec">{"pi": 3.14159}</span>\n\n` +
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> python3 --version\n` +
        `Python 3.11.2`,
    },
    fastfetch: {
      title: "fastfetch / neofetch — Instant system info in vibrant color",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> fastfetch\n` +
        `<span class="c-exec">root@golinux</span>\n` +
        `<span class="t-dim">--------------------------</span>\n` +
        `<span class="c-dir">OS</span>: Debian GNU/Linux 12 (bookworm) i686\n` +
        `<span class="c-dir">Host</span>: v86 WebAssembly VM (Browser)\n` +
        `<span class="c-dir">Kernel</span>: Linux 6.1 · <span class="c-dir">Memory</span>: 256 MiB`,
    },
    editors: {
      title: "vim & nano — Full-screen editing in xterm-256color",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> nano notes.md   <span class="t-dim"># or vim notes.md</span>\n` +
        `<span class="t-dim"># Opens cleanly in xterm-256color alternate screen.\n` +
        `# Tap Ctrl + O on mobile or desktop to save, Ctrl + X to exit.\n` +
        `# Leaves zero leftover UI lines in your scrollback.</span>`,
    },
    cli: {
      title: "htop, tmux, jq, tree, zip & man — Power-user CLI toolkit",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~/app</span><span class="t-muted">#</span> tree -L 2 &amp;&amp; echo '{"lang":"C"}' | jq -r .lang\n` +
        `<span class="c-dir">.</span>\n` +
        `├── <span class="c-c">main.c</span>\n` +
        `└── <span class="c-exec">Makefile</span>\n` +
        `<span class="c-warn">C</span>`,
    },
    fun: {
      title: "cowsay, figlet & sl — Classic terminal fun built right in",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> cowsay "Linux in a browser tab!"\n` +
        ` ___________________________\n` +
        `&lt; Linux in a browser tab! &gt;\n` +
        ` ---------------------------\n` +
        `        \\   ^__^\n` +
        `         \\  (oo)\\_______\n` +
        `            (__)\\       )\\/\\`,
    },
    ls: {
      title: "Vibrant shell — Colorized directories, executables & prompt",
      html:
        `<span class="t-prompt-u">root@golinux</span><span class="t-muted">:</span><span class="t-prompt-d">~</span><span class="t-muted">#</span> ls -la\n` +
        `drwxr-xr-x 2 root root 4096 <span class="c-dir">projects</span>\n` +
        `-rwxr-xr-x 1 root root 8192 <span class="c-exec">run.sh</span>\n` +
        `-rw-r--r-- 1 root root  412 <span class="c-c">main.c</span>\n` +
        `lrwxrwxrwx 1 root root    9 <span class="c-sym">latest -&gt; projects</span>\n` +
        `-rw-r--r-- 1 root root 2048 <span class="c-arc">release.tar.gz</span>`,
    },
  };

  const toolTitle = document.getElementById("toolTitle");
  const toolCode = document.getElementById("toolCode");
  const toolPills = Array.from(document.querySelectorAll(".tool-pill"));

  function showTool(key) {
    const d = DEMOS[key];
    if (!d) return;
    if (toolTitle) toolTitle.textContent = d.title;
    if (toolCode) toolCode.innerHTML = d.html;
    toolPills.forEach((p) => {
      const on = p.dataset.tool === key;
      p.classList.toggle("active", on);
      p.setAttribute("aria-selected", String(on));
    });
  }

  toolPills.forEach((p) => p.addEventListener("click", () => showTool(p.dataset.tool)));
  showTool("gcc");
})();
