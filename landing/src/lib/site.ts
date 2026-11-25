export const SITE = {
  name: "GoLinux",
  url: "https://golinux.app",
  terminalUrl:
    process.env.NEXT_PUBLIC_TERMINAL_URL ?? "https://terminal.golinux.app",
  academyUrl:
    process.env.NEXT_PUBLIC_ACADEMY_URL ?? "https://academy.golinux.app",
  githubUrl: "https://github.com/ShajinAhsan/golinux",
  authorName: "Shajin Ahsan",
  authorGithubUrl: "https://github.com/shajinahsan",
  title: "GoLinux — Ultra-lightweight Alpine Linux inside your browser",
  description:
    "An ultra-lightweight Alpine Linux 3.21 machine with BusyBox and TinyCC running 100% in your browser via WebAssembly. Boots in under a second. No server, no signup, works offline.",
  shortDescription:
    "Real Alpine Linux 3.21 running locally in your browser via WebAssembly.",
  themeColor: "#ffffff",
} as const;
