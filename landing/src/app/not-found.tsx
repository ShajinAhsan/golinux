import type { Metadata } from "next";
import Link from "next/link";
import { CurrentRoutePath } from "@/components/CurrentRoutePath";
import StatusScreen from "@/components/StatusScreen";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "404 — Page Not Found",
  robots: {
    index: false,
    follow: false,
  },
};

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      codeClassName="text-[clamp(7.5rem,22vw,16rem)]"
      eyebrow="System response / 404"
      title="This route took a wrong turn."
      description="The page you are looking for is missing, moved, or mistyped. Nothing is broken on your end."
      actions={
        <>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <span>Return home</span>
            <svg
              viewBox="0 0 20 20"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 10h12M11 5l5 5-5 5" />
            </svg>
          </Link>
          <a
            href={SITE.terminalUrl}
            className="inline-flex items-center justify-center rounded-full border border-border bg-canvas px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-secondary hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Open terminal
          </a>
        </>
      }
      command="locate route"
      errorLabel="route not found"
      rows={[
        { label: "searched", value: <CurrentRoutePath /> },
        { label: "status", value: "disconnected" },
      ]}
      signal="signal lost / searching"
      dotColor="#1d1d1f"
      showGlow
      footer={
        <div className="mt-5 flex items-center justify-between">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-secondary">
            error.log / 000404
          </span>
          <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.16em] text-[#3d7a55]">
            recoverable
          </span>
        </div>
      }
    />
  );
}
