"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

interface NavItem {
  label: string;
  href: string;
}

export function MobileNav({
  items,
  terminalUrl,
}: {
  items: readonly NavItem[];
  terminalUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        className="relative inline-flex size-9 items-center justify-center rounded-full border border-border bg-canvas text-ink transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas cursor-pointer"
      >
        <span
          aria-hidden="true"
          className="relative flex size-[18px] items-center justify-center"
        >
          <span
            className={`absolute h-[1.6px] w-[16px] rounded-full bg-ink transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              open ? "translate-y-0 rotate-45" : "-translate-y-[5px] rotate-0"
            }`}
          />
          <span
            className={`absolute h-[1.6px] w-[16px] rounded-full bg-ink transition-all duration-200 ease-out motion-reduce:transition-none ${
              open ? "scale-x-0 opacity-0" : "scale-x-100 opacity-100"
            }`}
          />
          <span
            className={`absolute h-[1.6px] w-[16px] rounded-full bg-ink transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              open ? "translate-y-0 -rotate-45" : "translate-y-[5px] rotate-0"
            }`}
          />
        </span>
      </button>

      {/* Backdrop scrim */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-x-0 top-16 z-30 h-[calc(100dvh-4rem)] bg-black/20 backdrop-blur-[2px] transition-opacity duration-200 motion-reduce:transition-none ${
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      />

      {/* Editorial monochrome slide-down drawer */}
      <nav
        id={menuId}
        aria-label="Mobile navigation"
        aria-hidden={!open}
        className={`fixed inset-x-0 top-16 z-40 origin-top border-b border-border bg-white px-6 pt-3 pb-6 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.14)] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-2 opacity-0"
        }`}
      >
        <ul className="mx-auto max-w-[1180px] divide-y divide-border-soft">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                tabIndex={open ? 0 : -1}
                onClick={() => setOpen(false)}
                className="group flex items-center justify-between py-4 text-[20px] font-semibold tracking-[-0.025em] text-ink transition-colors hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                <span>{item.label}</span>
                <svg
                  viewBox="0 0 20 20"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="text-secondary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink"
                >
                  <path d="M7.5 5l5 5-5 5" />
                </svg>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-5 max-w-[1180px] border-t border-border-soft pt-5">
          <a
            href={terminalUrl}
            tabIndex={open ? 0 : -1}
            onClick={() => setOpen(false)}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-semibold text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <span>Open the terminal</span>
            <svg
              viewBox="0 0 20 20"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 10h12M11 5l5 5-5 5" />
            </svg>
          </a>
          <p className="mt-3 text-center text-xs text-secondary">
            Alpine Linux 3.21 · Runs 100% locally in your browser
          </p>
        </div>
      </nav>
    </div>
  );
}
