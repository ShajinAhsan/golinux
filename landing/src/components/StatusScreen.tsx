import type { CSSProperties, ReactNode } from "react";
import { WindowDots } from "./TermBits";

export type DiagnosticRow = {
  label: string;
  value: ReactNode;
};

type StatusScreenProps = {
  code: string;
  codeClassName: string;
  eyebrow: string;
  title: string;
  description: string;
  actions: ReactNode;
  command: string;
  errorLabel: string;
  rows: DiagnosticRow[];
  signal: string;
  dotColor: string;
  eyebrowDotColor?: string;
  showGlow?: boolean;
  footer?: ReactNode;
};

/**
 * Shared diagnostic status layout for GoLinux 404 and 500 pages.
 */
export default function StatusScreen({
  code,
  codeClassName,
  eyebrow,
  title,
  description,
  actions,
  command,
  errorLabel,
  rows,
  signal,
  dotColor,
  eyebrowDotColor = "#d9483b",
  showGlow = false,
  footer,
}: StatusScreenProps) {
  return (
    <main
      id="main-content"
      aria-labelledby="status-title"
      className="relative isolate flex min-h-screen w-full items-center overflow-hidden bg-canvas px-4 py-12 text-ink sm:px-6 md:px-10 lg:px-16"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-75"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-border-soft) 1px, transparent 1px), linear-gradient(90deg, var(--color-border-soft) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "linear-gradient(to bottom, black 0%, transparent 82%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0%, transparent 82%)",
        }}
      />

      {showGlow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-44 -top-44 -z-10 h-[35rem] w-[35rem]"
          style={{
            background:
              "radial-gradient(closest-side, rgba(29, 29, 31, 0.06) 0%, rgba(29, 29, 31, 0.025) 55%, transparent 100%)",
          }}
        />
      )}

      <div className="mx-auto grid w-full max-w-[1180px] items-center gap-12 lg:grid-cols-[1fr_0.85fr] lg:gap-16">
        <section>
          <div className="font-mono mb-7 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-secondary">
            <span
              aria-hidden="true"
              className="size-2 rounded-full animate-pulse motion-reduce:animate-none"
              style={{ background: eyebrowDotColor }}
            />
            {eyebrow}
          </div>

          <h1
            id="status-title"
            className={`font-sans font-extrabold leading-[0.8] tracking-[-0.06em] text-ink ${codeClassName}`}
          >
            {code}
          </h1>

          <div className="mt-8 max-w-xl">
            <p className="font-sans text-[clamp(2rem,4.8vw,3.5rem)] leading-[1.02] font-extrabold tracking-[-0.04em] text-ink">
              {title}
            </p>
            <p className="mt-5 max-w-[44ch] text-[16px] leading-relaxed text-secondary">
              {description}
            </p>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {actions}
          </div>
        </section>

        <section
          aria-label="Route diagnostics"
          className="relative overflow-hidden rounded-[28px] border border-border bg-canvas p-5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.12)] md:p-7"
        >
          <div className="flex items-center justify-between border-b border-border-soft pb-4">
            <WindowDots />
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-secondary">
              route-monitor
            </span>
          </div>

          <div className="font-mono py-7 text-[11.5px] leading-loose sm:text-xs">
            <p>
              <span className="font-semibold text-[#3d7a55]">root@golinux</span>
              <span className="text-secondary">:</span>
              <span className="font-semibold text-[#3f6b94]">~</span>
              <span className="text-secondary"># </span>
              <span className="text-ink">{command}</span>
            </p>
            <p className="mt-4 text-[#b9382c]">
              <span className="mr-2" aria-hidden="true">
                x
              </span>
              {errorLabel}
            </p>
            {rows.map((row) => (
              <p key={row.label} className="text-secondary">
                {row.label}:{" "}
                <span className="font-medium text-ink">{row.value}</span>
              </p>
            ))}
          </div>

          <div
            aria-hidden="true"
            className="relative h-48 overflow-hidden rounded-2xl border border-border-soft bg-subtle"
          >
            <div className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-border" />
            <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border border-ink/35" />
            <span
              className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={
                {
                  background: dotColor,
                  boxShadow: `0 0 16px ${dotColor}`,
                } as CSSProperties
              }
            />
            <span
              className="absolute left-1/2 top-1/2 h-px w-1/2 origin-left animate-spin motion-reduce:animate-none"
              style={{
                background:
                  "linear-gradient(90deg, var(--color-ink), transparent)",
                animationDuration: "4s",
              }}
            />
            <span className="absolute bottom-2.5 left-3 font-mono text-[9.5px] uppercase tracking-[0.16em] text-secondary">
              {signal}
            </span>
          </div>

          {footer}
        </section>
      </div>
    </main>
  );
}
