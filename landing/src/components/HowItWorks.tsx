"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface ArchStep {
  title: string;
  description: string;
  caption: string;
  codeWord?: string;
}

const STEPS: readonly ArchStep[] = [
  {
    title: "Browser = Virtual PC",
    description:
      "WebAssembly emulates a real x86 CPU right inside your tab. No backend servers exist.",
    caption:
      "Your browser starts a lightweight 128 MB virtual x86 PC using WebAssembly. Nothing runs on a remote server.",
  },
  {
    title: "Instant Snapshot Boot",
    description:
      "Instead of a slow boot, a tiny saved memory snapshot wakes Alpine straight at your prompt in under a second.",
    caption:
      "A compact pre-booted memory snapshot loads once into RAM, waking Alpine Linux at the prompt in under a second.",
  },
  {
    title: "Smart Hybrid Bundles",
    description:
      "Core tools stay hot in RAM; larger tools stream in small <640 KB bundles from edge CDN straight into your local cache.",
    caption:
      "Core BusyBox commands stay hot in RAM; larger tools stream in tiny <640 KB bundles from Cloudflare's edge cache.",
  },
  {
    title: "Saved Privately on Device",
    description:
      "Your files in /root auto-save to browser storage (OPFS) and survive reloads, never leaving your device.",
    caption:
      "Files you save in /root persist privately in your browser's OPFS storage and survive reloads.",
    codeWord: "/root",
  },
] as const;

const SANS = { fontFamily: "var(--font-sans)" } as const;
const MONO = { fontFamily: "var(--font-mono)" } as const;

function ArchNode({
  x,
  y,
  w,
  h,
  active,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={16}
        fill="#ffffff"
        stroke={active ? "#1d1d1f" : "#d2d2d7"}
        strokeWidth={active ? 2 : 1.2}
        className="transition-all duration-300"
      />
      {children}
    </g>
  );
}

function VerticalConnector({
  active,
  delayed = false,
  label,
}: {
  active: boolean;
  delayed?: boolean;
  label: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative flex items-center justify-center gap-2.5 py-1.5"
    >
      <div className="relative flex h-8 w-5 flex-col items-center justify-between">
        <span
          className={`h-full w-0 border-l-2 border-dashed transition-colors duration-300 ${
            active ? "border-ink" : "border-border"
          }`}
        />
        {active ? (
          <span
            className={`v-packet absolute top-0 left-1/2 -ml-[4px] size-2 rounded-full bg-ink ${
              delayed ? "v-packet-delayed" : "v-packet-active"
            }`}
          />
        ) : null}
        <svg
          viewBox="0 0 12 8"
          width="10"
          height="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`-mt-1 shrink-0 transition-colors duration-300 ${
            active ? "text-ink" : "text-border"
          }`}
        >
          <path d="M2 1.5L6 5.5L10 1.5" />
        </svg>
      </div>
      <span
        className={`font-mono text-[11px] transition-colors duration-300 ${
          active ? "font-semibold text-ink" : "text-secondary"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function MobileNodeCard({
  title,
  subtitle,
  badge,
  active,
  onClick,
  icon,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
        active
          ? "border-ink bg-canvas shadow-[0_6px_20px_-10px_rgba(0,0,0,0.18)]"
          : "border-border bg-canvas/80 hover:border-secondary"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors duration-300 ${
          active
            ? "border-ink bg-ink text-canvas"
            : "border-border bg-subtle text-secondary"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-ink">{title}</span>
          {badge ? (
            <span className="rounded-full border border-border bg-subtle px-2 py-0.5 font-mono text-[10px] font-semibold text-ink">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-secondary">
          {subtitle}
        </span>
      </span>
    </button>
  );
}

export function HowItWorks() {
  const [currentStep, setCurrentStep] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const [announceStep, setAnnounceStep] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setUserPaused(true);
    }
    const onMotionChange = (event: MediaQueryListEvent) => {
      if (event.matches) setUserPaused(true);
    };
    mq.addEventListener("change", onMotionChange);
    return () => mq.removeEventListener("change", onMotionChange);
  }, []);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setIsVisible(entries.some((entry) => entry.isIntersecting));
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      setIsDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const isRunning = !userPaused && isVisible && isDocumentVisible;

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => {
      setAnnounceStep(false);
      setCurrentStep((prev) => (prev + 1) % STEPS.length);
    }, 3600);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const selectStep = useCallback((idx: number, focusTab = false) => {
    setAnnounceStep(true);
    setCurrentStep(idx);
    if (focusTab) {
      tabRefs.current[idx]?.focus();
    }
  }, []);

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectStep((idx + 1) % STEPS.length, true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectStep((idx - 1 + STEPS.length) % STEPS.length, true);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectStep(0, true);
    } else if (event.key === "End") {
      event.preventDefault();
      selectStep(STEPS.length - 1, true);
    }
  };

  const active = STEPS[currentStep];

  const isEdgeActive = currentStep === 2;
  const isSwActive = currentStep === 1 || currentStep === 2;
  const isVmActive =
    currentStep === 0 || currentStep === 1 || currentStep === 3;
  const isOpfsActive = currentStep === 3;

  const isR2SwLinkActive = currentStep === 2;
  const isSwVmLinkActive = currentStep === 1 || currentStep === 2;
  const isVmOpfsLinkActive = currentStep === 3;

  return (
    <div className="overflow-hidden rounded-[26px] border border-border bg-canvas">
      <div
        ref={stageRef}
        id="how-tabpanel"
        role="tabpanel"
        aria-labelledby={`how-tab-${currentStep}`}
        className="border-b border-border px-4 pt-5 pb-5 sm:px-6"
      >
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-subtle px-3 py-1 font-mono text-[11px] font-semibold text-ink">
            Step {currentStep + 1} of {STEPS.length}
          </span>
          <p
            aria-live={announceStep ? "polite" : "off"}
            className="min-w-[220px] flex-1 text-sm text-ink"
          >
            {active.caption}
          </p>
          <button
            type="button"
            onClick={() => setUserPaused((prev) => !prev)}
            aria-pressed={userPaused}
            aria-label={
              userPaused
                ? "Play architecture animation"
                : "Pause architecture animation"
            }
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas cursor-pointer"
          >
            {userPaused ? (
              <svg
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4 3l9 5-9 5V3z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="3.5" y="3" width="3" height="10" rx="0.8" />
                <rect x="9.5" y="3" width="3" height="10" rx="0.8" />
              </svg>
            )}
            <span>{userPaused ? "Play" : "Pause"}</span>
          </button>
        </div>

        {/* Mobile vertical animated pipeline (zero horizontal scroll) */}
        <div
          className={`arch-mobile md:hidden ${isRunning ? "" : "paused"}`}
          aria-label="GoLinux vertical architecture flow"
        >
          <p className="mb-2 px-1 font-mono text-[11px] font-semibold tracking-wide text-secondary uppercase">
            Edge CDN · Static files
          </p>
          <MobileNodeCard
            title="Hybrid Bundles"
            subtitle="<640 KB compressed files on Cloudflare R2"
            active={isEdgeActive}
            onClick={() => selectStep(2)}
            icon={
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <line x1="7" y1="10" x2="17" y2="10" />
                <line x1="7" y1="14" x2="13" y2="14" />
              </svg>
            }
          />

          <VerticalConnector
            active={isR2SwLinkActive}
            label="Streams bundles on demand"
          />

          <div className="rounded-2xl border border-dashed border-border bg-subtle p-3.5">
            <p className="mb-2.5 px-0.5 font-mono text-[11px] font-semibold tracking-wide text-secondary uppercase">
              Your browser tab · 100% on your device
            </p>

            <MobileNodeCard
              title="Smart Cache"
              subtitle="Fetches only what you use, then caches locally"
              active={isSwActive}
              onClick={() => selectStep(1)}
              icon={
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="8" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              }
            />

            <VerticalConnector
              active={isSwVmLinkActive}
              delayed={currentStep === 2}
              label={
                currentStep === 1
                  ? "Wakes snapshot into RAM"
                  : "Unpacks cached disk slices"
              }
            />

            <MobileNodeCard
              title="Virtual x86 PC"
              subtitle="Alpine 3.21 in WASM · 128 MB RAM, xterm"
              badge="Wakes in <1s"
              active={isVmActive}
              onClick={() => selectStep(0)}
              icon={
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="5 8 10 12 5 16" />
                  <line x1="12" y1="16" x2="19" y2="16" />
                </svg>
              }
            />

            <VerticalConnector
              active={isVmOpfsLinkActive}
              label="Auto-saves /root privately"
            />

            <MobileNodeCard
              title="Private Vault"
              subtitle="Saved in browser OPFS on your device"
              active={isOpfsActive}
              onClick={() => selectStep(3)}
              icon={
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="4" y="6" width="16" height="12" rx="2.5" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
              }
            />
          </div>
        </div>

        {/* Desktop horizontal SVG diagram */}
        <div className="hidden w-full md:block">
          <svg
            data-active-step={String(currentStep)}
            className={`arch-svg block h-auto w-full ${
              isRunning ? "" : "paused"
            }`}
            viewBox="0 0 880 280"
            role="img"
            aria-labelledby="arch-svg-title arch-svg-desc"
          >
            <title id="arch-svg-title">
              GoLinux client-side WebAssembly architecture diagram
            </title>
            <desc id="arch-svg-desc">
              Diagram showing static hybrid disk bundles on Cloudflare R2
              flowing into the browser Service Worker smart cache, powering a
              128 MB Alpine Linux 3.21 virtual x86 PC in WebAssembly, and saving
              user files privately in local OPFS storage.
            </desc>

            {/* Browser boundary box */}
            <rect
              x="242"
              y="18"
              width="620"
              height="244"
              rx="20"
              fill="#f5f5f7"
              stroke="#d2d2d7"
              strokeWidth="1.2"
              strokeDasharray="6 5"
            />
            <text
              x="262"
              y="42"
              fill="#6e6e73"
              fontSize="12"
              fontWeight="600"
              style={SANS}
            >
              Your browser tab, 100% on your device
            </text>
            <text
              x="24"
              y="42"
              fill="#6e6e73"
              fontSize="12"
              fontWeight="600"
              style={SANS}
            >
              Edge CDN, static files
            </text>

            {/* Connection paths */}
            <path
              d="M 196 142 L 278 142"
              fill="none"
              stroke={isR2SwLinkActive ? "#1d1d1f" : "#d2d2d7"}
              strokeWidth={isR2SwLinkActive ? 2.2 : 1.6}
              strokeDasharray="5 5"
              className="transition-all duration-300"
            />
            <path
              d="M 434 142 L 500 142"
              fill="none"
              stroke={isSwVmLinkActive ? "#1d1d1f" : "#d2d2d7"}
              strokeWidth={isSwVmLinkActive ? 2.2 : 1.6}
              strokeDasharray="5 5"
              className="transition-all duration-300"
            />
            <path
              d="M 664 142 L 716 142"
              fill="none"
              stroke={isVmOpfsLinkActive ? "#1d1d1f" : "#d2d2d7"}
              strokeWidth={isVmOpfsLinkActive ? 2.2 : 1.6}
              strokeDasharray="5 5"
              className="transition-all duration-300"
            />

            {/* Monochromatic data packets */}
            <g className="packet p-r2-sw">
              <circle r="4.5" fill="#1d1d1f" />
            </g>
            <g className="packet p-sw-vm">
              <circle r="4.5" fill="#1d1d1f" />
            </g>
            <g className="packet p-vm-opfs">
              <circle r="4.5" fill="#1d1d1f" />
            </g>

            {/* Node 1: Edge storage */}
            <ArchNode x={24} y={82} w={172} h={120} active={isEdgeActive}>
              <rect
                x="42"
                y="102"
                width="32"
                height="24"
                rx="6"
                fill={isEdgeActive ? "#1d1d1f" : "#f5f5f7"}
                stroke={isEdgeActive ? "#1d1d1f" : "#d2d2d7"}
                strokeWidth="1.2"
              />
              <line
                x1="49"
                y1="110"
                x2="67"
                y2="110"
                stroke={isEdgeActive ? "#ffffff" : "#6e6e73"}
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <line
                x1="49"
                y1="118"
                x2="62"
                y2="118"
                stroke={isEdgeActive ? "#ffffff" : "#6e6e73"}
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <text
                x="42"
                y="148"
                fill="#1d1d1f"
                fontSize="14"
                fontWeight="700"
                style={SANS}
              >
                Hybrid Bundles
              </text>
              <text x="42" y="167" fill="#6e6e73" fontSize="11.5" style={SANS}>
                &lt;640 KB compressed
              </text>
              <text x="42" y="184" fill="#6e6e73" fontSize="11.5" style={SANS}>
                files on Cloudflare R2
              </text>
            </ArchNode>

            {/* Node 2: Service worker cache */}
            <ArchNode x={278} y={82} w={156} h={120} active={isSwActive}>
              <circle
                cx="312"
                cy="114"
                r="13"
                fill={isSwActive ? "#1d1d1f" : "#f5f5f7"}
                stroke={isSwActive ? "#1d1d1f" : "#d2d2d7"}
                strokeWidth="1.2"
              />
              <path
                d="M 307 114 L 311 118 L 318 110"
                fill="none"
                stroke={isSwActive ? "#ffffff" : "#6e6e73"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <text
                x="296"
                y="148"
                fill="#1d1d1f"
                fontSize="14"
                fontWeight="700"
                style={SANS}
              >
                Smart Cache
              </text>
              <text x="296" y="167" fill="#6e6e73" fontSize="11.5" style={SANS}>
                Fetches only what
              </text>
              <text x="296" y="184" fill="#6e6e73" fontSize="11.5" style={SANS}>
                you use, then caches
              </text>
            </ArchNode>

            {/* Node 3: WebAssembly virtual PC */}
            <ArchNode x={500} y={72} w={164} h={140} active={isVmActive}>
              <rect
                x="518"
                y="92"
                width="34"
                height="24"
                rx="6"
                fill={isVmActive ? "#1d1d1f" : "#f5f5f7"}
                stroke={isVmActive ? "#1d1d1f" : "#d2d2d7"}
                strokeWidth="1.2"
              />
              <path
                d="M 526 100 L 531 104 L 526 108 M 534 108 L 543 108"
                fill="none"
                stroke={isVmActive ? "#ffffff" : "#6e6e73"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <text
                x="518"
                y="140"
                fill="#1d1d1f"
                fontSize="14"
                fontWeight="700"
                style={SANS}
              >
                Virtual x86 PC
              </text>
              <text x="518" y="159" fill="#1d1d1f" fontSize="11.5" style={SANS}>
                Alpine 3.21 in WASM
              </text>
              <text x="518" y="176" fill="#6e6e73" fontSize="11.5" style={SANS}>
                128 MB RAM, xterm
              </text>
              <text
                x="518"
                y="196"
                fill="#1d1d1f"
                fontSize="11"
                fontWeight="700"
                style={MONO}
              >
                Wakes in &lt;1 sec
              </text>
            </ArchNode>

            {/* Node 4: Private OPFS vault */}
            <ArchNode x={716} y={82} w={128} h={120} active={isOpfsActive}>
              <rect
                x="734"
                y="102"
                width="26"
                height="22"
                rx="6"
                fill={isOpfsActive ? "#1d1d1f" : "#f5f5f7"}
                stroke={isOpfsActive ? "#1d1d1f" : "#d2d2d7"}
                strokeWidth="1.2"
              />
              <circle
                cx="747"
                cy="113"
                r="3"
                fill="none"
                stroke={isOpfsActive ? "#ffffff" : "#6e6e73"}
                strokeWidth="2"
              />
              <text
                x="734"
                y="148"
                fill="#1d1d1f"
                fontSize="14"
                fontWeight="700"
                style={SANS}
              >
                Private Vault
              </text>
              <text x="734" y="167" fill="#6e6e73" fontSize="11.5" style={SANS}>
                Saved in OPFS
              </text>
              <text x="734" y="184" fill="#6e6e73" fontSize="11.5" style={SANS}>
                on your device
              </text>
            </ArchNode>
          </svg>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Architecture steps"
        className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4"
      >
        {STEPS.map((step, idx) => {
          const isActive = idx === currentStep;
          return (
            <button
              key={step.title}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              id={`how-tab-${idx}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="how-tabpanel"
              tabIndex={isActive ? 0 : -1}
              onClick={() => selectStep(idx)}
              onKeyDown={(event) => handleTabKeyDown(event, idx)}
              className={`group flex cursor-pointer flex-col gap-2 px-5 py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink sm:border-t sm:border-border lg:border-t-0 lg:border-r lg:last:border-r-0 ${
                idx % 2 === 0 ? "sm:border-r sm:border-border" : ""
              } ${
                isActive
                  ? "bg-subtle shadow-[inset_0_2px_0_#1d1d1f]"
                  : "bg-canvas hover:bg-subtle/60"
              }`}
            >
              <span
                className={`inline-flex size-7 items-center justify-center rounded-full font-mono text-xs font-bold transition-colors ${
                  isActive
                    ? "bg-ink text-canvas"
                    : "border border-border bg-subtle text-secondary group-hover:text-ink"
                }`}
              >
                {idx + 1}
              </span>
              <span className="text-[15px] font-bold text-ink">
                {step.title}
              </span>
              <span className="text-[13px] leading-relaxed text-secondary">
                {step.codeWord ? (
                  <>
                    Your files in{" "}
                    <code className="rounded border border-border bg-canvas px-1.5 py-0.5 font-mono text-[0.88em] text-ink">
                      {step.codeWord}
                    </code>{" "}
                    auto-save to browser storage (OPFS) and survive reloads,
                    never leaving your device.
                  </>
                ) : (
                  step.description
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
