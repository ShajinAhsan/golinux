"use client";

import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Prompt, WindowDots } from "./TermBits";

interface Entry {
  id: number;
  cmd: string;
  out: ReactNode;
}

type Result = { kind: "clear" } | { kind: "out"; out: ReactNode };

const out = (node: ReactNode): Result => ({ kind: "out", out: node });

const INTRO = ["ls -F", "tcc -run hello.c"] as const;

const QUICK = [
  "ls -F",
  "cat hello.c",
  "tcc -run hello.c",
  "fastfetch",
  "cowsay hi",
  "git log --oneline",
] as const;

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

const REAL_TOOLS = [
  "python3",
  "git",
  "vim",
  "nano",
  "htop",
  "tmux",
  "jq",
  "tree",
  "curl",
  "make",
  "figlet",
  "sl",
  "bash",
  "zip",
  "unzip",
  "man",
  "less",
  "file",
];

const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["ls", "list files"],
  ["cat hello.c", "print a C file"],
  ["tcc -run hello.c", "compile and run it"],
  ["fastfetch", "system info"],
  ["cowsay hi", "a talking cow"],
  ["git log --oneline", "commit history"],
  ["clear", "clean the screen"],
];

const HELP = (
  <>
    {HELP_ROWS.map(([cmd, desc]) => (
      <span key={cmd} className="block">
        <span className="text-term-fg">{cmd.padEnd(19)}</span>
        <span className="text-term-muted">{desc}</span>
      </span>
    ))}
  </>
);

const LS = (
  <span className="flex flex-wrap gap-x-4 gap-y-1">
    <span className="font-semibold text-term-blue">projects/</span>
    <span className="font-semibold text-term-blue">notes/</span>
    <span className="text-term-text">hello.c</span>
    <span className="font-semibold text-term-green">build.sh*</span>
    <span className="text-term-text">backup.tar.gz</span>
    <span className="text-term-blue">latest@</span>
  </span>
);

const CAT = (
  <>
    <span className="text-term-muted">#include</span>{" "}
    <span className="text-term-green">&lt;stdio.h&gt;</span>
    {"\n"}
    <span className="text-term-blue">int</span>{" "}
    <span className="text-term-fg">main</span>(
    <span className="text-term-blue">void</span>) {"{"}
    {"\n  "}
    <span className="text-term-fg">puts</span>(
    <span className="text-term-green">&quot;Hello from TinyCC!&quot;</span>);
    {"\n  "}
    <span className="text-term-blue">return</span>{" "}
    <span className="text-term-amber">0</span>;{"\n"}
    {"}"}
  </>
);

const HELLO = (
  <span className="font-semibold text-term-amber">Hello from TinyCC!</span>
);

const GIT_LOG = (
  <>
    <span className="font-semibold text-term-amber">9a4f1c2</span>{" "}
    <span className="text-term-muted">(HEAD -&gt; </span>
    <span className="font-semibold text-term-green">master</span>
    <span className="text-term-muted">)</span>{" "}
    <span className="text-term-text">init</span>
  </>
);

const FETCH = (
  <>
    <span className="font-semibold text-term-green">root</span>
    <span className="text-term-muted">@</span>
    <span className="font-semibold text-term-green">golinux</span>
    {"\n"}
    <span className="text-term-muted">------------</span>
    {"\n"}
    <span className="font-semibold text-term-blue">OS</span>: Alpine Linux 3.21
    i686{"\n"}
    <span className="font-semibold text-term-blue">Host</span>: v86 WebAssembly
    VM (128 MiB){"\n"}
    <span className="font-semibold text-term-blue">Kernel</span>: Linux 6.12
    {"\n"}
    <span className="font-semibold text-term-blue">Shell</span>: bash 5.2
    {"\n"}
    <span className="mt-1.5 flex">
      {SWATCHES.map((cls) => (
        <span key={cls} className={`h-3.5 w-6 ${cls}`} />
      ))}
    </span>
  </>
);

function cowsay(text: string): ReactNode {
  const msg = text.trim() || "moo";
  const top = ` ${"_".repeat(msg.length + 2)}`;
  const bottom = ` ${"-".repeat(msg.length + 2)}`;
  return (
    <>
      <span className="text-term-amber">{`${top}\n< ${msg} >\n${bottom}`}</span>
      <span className="text-term-text">
        {
          "\n        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||"
        }
      </span>
    </>
  );
}

function execute(raw: string): Result {
  const input = raw.trim();
  if (!input) return out(null);
  if (input === "clear") return { kind: "clear" };

  const [name, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ");

  switch (name) {
    case "help":
      return out(HELP);
    case "ls":
      return out(LS);
    case "pwd":
      return out("/root");
    case "whoami":
      return out("root");
    case "uname":
      return out("Linux golinux 6.12.0-virt #1-Alpine SMP i686 Linux");
    case "echo":
      return out(arg);
    case "cat":
      if (arg === "hello.c") return out(CAT);
      return out(
        <span className="text-term-amber">
          cat: can&apos;t open &apos;{arg}&apos;: No such file or directory
        </span>,
      );
    case "tcc":
      if (/hello\.c/.test(arg)) return out(HELLO);
      return out(<span className="text-term-amber">tcc: no input files</span>);
    case "./hello":
      return out(HELLO);
    case "fastfetch":
    case "neofetch":
      return out(FETCH);
    case "cowsay":
      return out(cowsay(arg));
    case "git":
      if (arg.startsWith("log")) return out(GIT_LOG);
      break;
    case "rm":
      if (arg.includes("-rf") && arg.includes("/")) {
        return out(
          <span className="text-term-amber">
            Go for it. Reset brings back a clean Alpine in a second.
          </span>,
        );
      }
      break;
    default:
      break;
  }

  if (REAL_TOOLS.includes(name)) {
    return out(
      <span className="text-term-muted">
        This demo only knows a few commands. Open the terminal to run {name} for
        real.
      </span>,
    );
  }

  return out(<span className="text-term-amber">sh: {name}: not found</span>);
}

export function HeroTerminal() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [typing, setTyping] = useState("");
  const [introDone, setIntroDone] = useState(false);
  const [value, setValue] = useState("");

  const idRef = useRef(0);
  const abortRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(-1);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = useCallback((cmd: string) => {
    const result = execute(cmd);
    if (result.kind === "clear") {
      setEntries([]);
      return;
    }
    idRef.current += 1;
    const id = idRef.current;
    setEntries((prev) => [...prev, { id, cmd, out: result.out }].slice(-30));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const stopped = () => cancelled || abortRef.current;

    (async () => {
      await wait(reduce ? 0 : 700);
      for (const cmd of INTRO) {
        if (stopped()) return;
        if (!reduce) {
          for (let i = 1; i <= cmd.length; i += 1) {
            if (stopped()) return;
            setTyping(cmd.slice(0, i));
            await wait(40 + Math.random() * 35);
          }
          await wait(300);
        }
        if (stopped()) return;
        setTyping("");
        submit(cmd);
        await wait(reduce ? 0 : 650);
      }
      if (!stopped()) setIntroDone(true);
    })();

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [submit]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, typing]);

  const takeOver = useCallback(() => {
    abortRef.current = true;
    setTyping("");
    setIntroDone(true);
  }, []);

  const takeOverAndFocus = useCallback(() => {
    takeOver();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [takeOver]);

  const runQuick = (cmd: string) => {
    takeOver();
    submit(cmd);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const cmd = value;
    setValue("");
    historyPosRef.current = -1;
    if (cmd.trim()) historyRef.current.push(cmd);
    submit(cmd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const history = historyRef.current;
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next =
        historyPosRef.current === -1
          ? history.length - 1
          : Math.max(0, historyPosRef.current - 1);
      historyPosRef.current = next;
      setValue(history[next]);
    } else if (event.key === "ArrowDown" && historyPosRef.current !== -1) {
      event.preventDefault();
      const next = historyPosRef.current + 1;
      if (next >= history.length) {
        historyPosRef.current = -1;
        setValue("");
      } else {
        historyPosRef.current = next;
        setValue(history[next]);
      }
    }
  };

  return (
    <div className="relative">
      <div
        role="region"
        aria-label="Interactive terminal demo"
        className="overflow-hidden rounded-[20px] border border-term-border bg-term-bg shadow-[0_24px_60px_-24px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-center gap-3 border-b border-term-border bg-term-chrome px-4 py-3">
          <WindowDots />
          <div className="truncate font-mono text-xs text-term-muted">
            terminal.golinux.app
          </div>
        </div>

        <div
          ref={bodyRef}
          role="log"
          aria-live={introDone ? "polite" : "off"}
          className="h-[300px] overflow-y-auto p-4 font-mono text-[13px] leading-[1.7] text-term-text sm:h-[340px] sm:p-5"
        >
          <p className="mb-2 text-term-muted">
            GoLinux, Alpine Linux 3.21 (x86). Type help, or tap a command below.
          </p>

          {entries.map((entry) => (
            <div key={entry.id} className="mb-1.5">
              <div className="break-words">
                <Prompt /> <span className="text-term-fg">{entry.cmd}</span>
              </div>
              {entry.out != null ? (
                <div className="break-words whitespace-pre-wrap text-term-text">
                  {entry.out}
                </div>
              ) : null}
            </div>
          ))}

          {introDone ? (
            <form onSubmit={onSubmit} className="flex items-center">
              <span className="shrink-0 whitespace-pre">
                <Prompt />
              </span>
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={onKeyDown}
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                aria-label="Type a command and press Enter"
                className="min-w-0 flex-1 bg-transparent font-mono text-base text-term-fg caret-term-fg outline-none sm:text-[13px]"
              />
            </form>
          ) : (
            <div
              onPointerDown={takeOverAndFocus}
              className="cursor-text break-words"
            >
              <Prompt /> <span className="text-term-fg">{typing}</span>
              <span
                aria-hidden="true"
                className="animate-cursor-blink ml-0.5 inline-block h-[15px] w-2 bg-term-fg align-[-2px]"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-term-border bg-term-chrome p-3">
          <span className="mr-1 text-xs text-term-muted">Tap to run</span>
          {QUICK.map((cmd) => (
            <button
              key={cmd}
              type="button"
              onClick={() => runQuick(cmd)}
              className="rounded-full border border-[#3a3a3c] bg-term-bg px-3 py-1.5 font-mono text-xs text-term-text transition-colors hover:border-[#636366] hover:text-term-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-fg focus-visible:ring-offset-2 focus-visible:ring-offset-term-chrome cursor-pointer"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
