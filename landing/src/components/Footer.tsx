import Link from "next/link";
import { SITE } from "@/lib/site";

const LINK_CLASS =
  "rounded-sm font-medium text-secondary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-subtle";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-subtle py-8 text-[13px] text-secondary">
      <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p>
            Built by{" "}
            <a
              href={SITE.authorGithubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-ink underline-offset-4 hover:underline"
            >
              {SITE.authorName}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            · MIT licensed · Powered by v86, xterm.js, SeaBIOS and Alpine Linux.
          </p>
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-5"
          >
            <a data-launch-url="" href={SITE.terminalUrl} className={LINK_CLASS}>
              Terminal
            </a>
            <a
              href={SITE.academyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              Academy
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <Link href="/about" className={LINK_CLASS}>
              Licenses and about
            </Link>
            <a
              href={SITE.authorGithubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              github.com/shajinahsan
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
