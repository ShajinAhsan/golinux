"use client";

import { SITE } from "@/lib/site";
import { useCallback, useRef, useState } from "react";
import { Prompt, WindowDots } from "./TermBits";

type ToolKey =
  | "gcc"
  | "python3"
  | "git"
  | "fastfetch"
  | "editors"
  | "cli"
  | "fun"
  | "ls";

interface ToolDemo {
  key: ToolKey;
  label: string;
  title: string;
  render: () => React.ReactNode;
}

const SWATCHES = [
  "bg-[#1c1c1e]",
  "bg-[#2c2c2e]",
  "bg-[#3a3a3c]",
  "bg-[#48484a]",
  "bg-[#636366]",
  "bg-[#8e8e93]",
  "bg-[#aeaeb2]",
  "bg-[#f5f5f7]",
] as const;

const TOOL_DEMOS: readonly ToolDemo[] = [
  {
    key: "gcc",
    label: "tcc / gcc",
    title: "tcc / gcc: instant TinyCC C compiler, sub-second even on mobile",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">cat hello.c</span>
        {"\n"}
        <span className="text-term-muted">#include</span>{" "}
        <span className="text-term-green">&lt;stdio.h&gt;</span>
        {"\n"}
        <span className="text-term-blue">int</span>{" "}
        <span className="text-term-fg">main</span>(
        <span className="text-term-blue">void</span>) {"{"}{" "}
        <span className="text-term-fg">puts</span>(
        <span className="text-term-green">&quot;Hello from TinyCC!&quot;</span>
        ); <span className="text-term-blue">return</span>{" "}
        <span className="text-term-amber">0</span>; {"}"}
        {"\n\n"}
        <Prompt />
        <span className="text-term-fg">
          tcc hello.c -o hello &amp;&amp; ./hello
        </span>
        {"   "}
        <span className="text-term-muted"># or: tcc -run hello.c</span>
        {"\n"}
        <span className="font-semibold text-term-amber">
          Hello from TinyCC!
        </span>
      </>
    ),
  },
  {
    key: "python3",
    label: "python3",
    title: "python3: real Python 3.12 interpreter and standard library",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">
          python3 -c &quot;import math, json;
          print(json.dumps(&#123;&apos;pi&apos;: round(math.pi, 5)&#125;))&quot;
        </span>
        {"\n"}
        <span className="font-semibold text-term-amber">
          {'{"pi": 3.14159}'}
        </span>
        {"\n\n"}
        <Prompt />
        <span className="text-term-fg">python3 --version</span>
        {"\n"}
        <span className="text-term-text">Python 3.12</span>
      </>
    ),
  },
  {
    key: "git",
    label: "git",
    title: "git: full local repositories, branches and diffs",
    render: () => (
      <>
        <Prompt dir="~/app" />
        <span className="text-term-fg">
          git init &amp;&amp; git add . &amp;&amp; git commit -m
          &quot;init&quot;
        </span>
        {"\n"}
        <span className="text-term-muted">
          {
            "[master (root-commit) 9a4f1c2] init\n 2 files changed, 18 insertions(+)"
          }
        </span>
        {"\n\n"}
        <Prompt dir="~/app" />
        <span className="text-term-fg">git log --oneline</span>
        {"\n"}
        <span className="font-semibold text-term-amber">9a4f1c2</span>{" "}
        <span className="text-term-muted">(HEAD -&gt; </span>
        <span className="font-semibold text-term-green">master</span>
        <span className="text-term-muted">)</span>{" "}
        <span className="text-term-text">init</span>
      </>
    ),
  },
  {
    key: "fastfetch",
    label: "fastfetch",
    title: "fastfetch: native C system info in crisp detail",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">fastfetch</span>
        {"\n"}
        <span className="font-semibold text-term-green">root</span>
        <span className="text-term-muted">@</span>
        <span className="font-semibold text-term-green">golinux</span>
        {"\n"}
        <span className="text-term-muted">------------</span>
        {"\n"}
        <span className="font-semibold text-term-blue">OS</span>
        <span className="text-term-text">: Alpine Linux 3.21 i686</span>
        {"\n"}
        <span className="font-semibold text-term-blue">Host</span>
        <span className="text-term-text">: v86 WebAssembly VM (128 MiB)</span>
        {"\n"}
        <span className="font-semibold text-term-blue">Kernel</span>
        <span className="text-term-text">: Linux 6.12</span>
        {"\n"}
        <span className="font-semibold text-term-blue">Shell</span>
        <span className="text-term-text">: bash 5.2</span>
        {"\n"}
        <span className="mt-2 flex">
          {SWATCHES.map((cls) => (
            <span key={cls} className={`h-4 w-7 ${cls}`} />
          ))}
        </span>
      </>
    ),
  },
  {
    key: "editors",
    label: "vim / nano",
    title: "vim and nano: full-screen editing in xterm-256color",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">nano notes.md</span>
        {"   "}
        <span className="text-term-muted"># or vim notes.md</span>
        {"\n"}
        <span className="text-term-muted">
          {
            "# Opens cleanly in the xterm-256color alternate screen.\n# Tap Ctrl + O on mobile or desktop to save, Ctrl + X to exit.\n# Leaves zero leftover UI lines in your scrollback."
          }
        </span>
      </>
    ),
  },
  {
    key: "cli",
    label: "htop / jq / tree",
    title: "htop, tmux, jq, tree, zip and man: a power-user CLI toolkit",
    render: () => (
      <>
        <Prompt dir="~/app" />
        <span className="text-term-fg">
          {'tree -L 2 && echo \'{"lang":"C"}\' | jq -r .lang'}
        </span>
        {"\n"}
        <span className="font-semibold text-term-blue">.</span>
        {"\n"}
        <span className="text-term-muted">├── </span>
        <span className="text-term-text">main.c</span>
        {"\n"}
        <span className="text-term-muted">└── </span>
        <span className="font-semibold text-term-green">Makefile</span>
        {"\n"}
        <span className="font-semibold text-term-amber">C</span>
      </>
    ),
  },
  {
    key: "fun",
    label: "cowsay / figlet",
    title: "cowsay, figlet and sl: classic terminal fun built right in",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">
          cowsay &quot;Linux in a browser tab!&quot;
        </span>
        {"\n"}
        <span className="text-term-amber">
          {` ___________________________
< Linux in a browser tab! >
 ---------------------------`}
        </span>
        <span className="text-term-text">
          {`
        \\   ^__^
         \\  (oo)\\_______
            (__)\\       )\\/\\`}
        </span>
      </>
    ),
  },
  {
    key: "ls",
    label: "colorful shell",
    title: "ls: clear directories, executables and symlinks",
    render: () => (
      <>
        <Prompt />
        <span className="text-term-fg">ls -la</span>
        {"\n"}
        <span className="text-term-muted">drwxr-xr-x 2 root root 4096 </span>
        <span className="font-semibold text-term-blue">projects/</span>
        {"\n"}
        <span className="text-term-muted">-rwxr-xr-x 1 root root 8192 </span>
        <span className="font-semibold text-term-green">run.sh*</span>
        {"\n"}
        <span className="text-term-muted">{"-rw-r--r-- 1 root root  412 "}</span>
        <span className="text-term-text">main.c</span>
        {"\n"}
        <span className="text-term-muted">{"lrwxrwxrwx 1 root root    9 "}</span>
        <span className="font-semibold text-term-blue">latest</span>
        <span className="text-term-muted"> -&gt; </span>
        <span className="font-semibold text-term-blue">projects</span>
        {"\n"}
        <span className="text-term-muted">-rw-r--r-- 1 root root 2048 </span>
        <span className="text-term-text">release.tar.gz</span>
      </>
    ),
  },
] as const;

export function ToolsExplorer() {
  const [activeKey, setActiveKey] = useState<ToolKey>("gcc");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = TOOL_DEMOS.findIndex((t) => t.key === activeKey);
  const activeTool = TOOL_DEMOS[activeIndex] ?? TOOL_DEMOS[0];

  const activateByIndex = useCallback((idx: number, focusTab = false) => {
    const next = TOOL_DEMOS[idx];
    if (!next) return;
    setActiveKey(next.key);
    if (focusTab) {
      tabRefs.current[idx]?.focus();
    }
  }, []);

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      activateByIndex((idx + 1) % TOOL_DEMOS.length, true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      activateByIndex((idx - 1 + TOOL_DEMOS.length) % TOOL_DEMOS.length, true);
    } else if (event.key === "Home") {
      event.preventDefault();
      activateByIndex(0, true);
    } else if (event.key === "End") {
      event.preventDefault();
      activateByIndex(TOOL_DEMOS.length - 1, true);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Included Alpine Linux tools"
        className="flex flex-wrap gap-2.5"
      >
        {TOOL_DEMOS.map((tool, idx) => {
          const isActive = tool.key === activeKey;
          return (
            <button
              key={tool.key}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              id={`tool-tab-${tool.key}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="tool-tabpanel"
              tabIndex={isActive ? 0 : -1}
              onClick={() => activateByIndex(idx)}
              onKeyDown={(event) => handleKeyDown(event, idx)}
              className={`rounded-full border px-4 py-2.5 font-mono text-[13px] leading-none font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas cursor-pointer ${
                isActive
                  ? "border-ink bg-ink text-canvas"
                  : "border-border bg-canvas text-secondary hover:border-secondary hover:bg-subtle hover:text-ink"
              }`}
            >
              {tool.label}
            </button>
          );
        })}
      </div>

      <div
        id="tool-tabpanel"
        role="tabpanel"
        aria-labelledby={`tool-tab-${activeTool.key}`}
        className="overflow-hidden rounded-[22px] border border-term-border bg-term-bg shadow-[0_20px_50px_-24px_rgba(0,0,0,0.22)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-term-border bg-term-chrome px-4 py-3">
          <WindowDots />
          <div className="truncate font-mono text-xs text-term-muted">
            {activeTool.title}
          </div>
          <a
            data-launch-url=""
            href={SITE.terminalUrl}
            className="shrink-0 rounded-sm text-xs font-bold text-term-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-fg focus-visible:ring-offset-2 focus-visible:ring-offset-term-chrome"
          >
            Try it
          </a>
        </div>
        <pre className="m-0 min-h-[200px] overflow-x-auto p-5 font-mono text-[13px] leading-[1.75] break-words whitespace-pre-wrap text-term-text">
          {activeTool.render()}
        </pre>
      </div>
    </div>
  );
}
