import Link from "next/link";
import { SITE } from "@/lib/site";
import { MobileNav } from "./MobileNav";

const NAV_ITEMS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Tools", href: "/#tools" },
  { label: "Features", href: "/#features" },
  { label: "Academy", href: "/#academy" },
  { label: "About", href: "/about" },
] as const;

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6">
        <Link
          href="/"
          aria-label="GoLinux home"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg text-lg font-extrabold tracking-[-0.03em] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas sm:gap-2.5"
        >
          <span
            aria-hidden="true"
            className="inline-flex size-8 items-center justify-center rounded-[10px] border border-border bg-subtle text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="5 8 10 12 5 16" />
              <line x1="12" y1="16" x2="19" y2="16" />
            </svg>
          </span>
          <span>GoLinux</span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-1 py-0.5 text-sm font-medium text-secondary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
          <a
            data-launch-url=""
            href={SITE.terminalUrl}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-ink px-3 py-2 text-[12.5px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas sm:px-4 sm:text-[13px]"
          >
            <span>Open terminal</span>
            <svg
              viewBox="0 0 20 20"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 10h12M11 5l5 5-5 5" />
            </svg>
          </a>
          <MobileNav items={NAV_ITEMS} terminalUrl={SITE.terminalUrl} />
        </div>
      </div>
    </header>
  );
}
