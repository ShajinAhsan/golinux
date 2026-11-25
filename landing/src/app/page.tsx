import { Footer } from "@/components/Footer";
import { HeroTerminal } from "@/components/HeroTerminal";
import { HowItWorks } from "@/components/HowItWorks";
import { Navbar } from "@/components/Navbar";
import { ToolsExplorer } from "@/components/ToolsExplorer";
import { SITE } from "@/lib/site";

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#website`,
      url: SITE.url,
      name: SITE.name,
      description: SITE.description,
      inLanguage: "en-US",
      sameAs: [SITE.academyUrl, SITE.githubUrl],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE.url}/#app`,
      name: SITE.name,
      url: SITE.url,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web Browser (WebAssembly), Alpine Linux 3.21",
      softwareVersion: "3.21",
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      description: SITE.description,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Alpine Linux 3.21 (x86) running locally via v86 WebAssembly",
        "Sub-second memory snapshot boot",
        "Pre-installed BusyBox, TinyCC, Python 3.12, git, nano, vim, htop, jq, and fastfetch",
        "Private local persistence via browser OPFS",
        "First-class mobile terminal with touch keybar and virtio-console resize",
        "Drag-and-drop file transfer directly into ~ (/root)",
      ],
    },
  ],
};

const INLINE_CODE_CLASS =
  "rounded-md border border-border bg-subtle px-1.5 py-0.5 font-mono text-[0.88em] text-ink";

const H2_CLASS =
  "mb-3 text-[clamp(1.9rem,4vw,3rem)] leading-[1.08] font-extrabold tracking-[-0.035em] text-ink";

const HERO_STATS = [
  { value: "<1s", label: "snapshot wake" },
  { value: "~9 MB", label: "first load" },
  { value: "MIT", label: "open source" },
] as const;

const SPECS = [
  { value: "Alpine 3.21", label: "Linux 6.12 + musl" },
  { value: "128 MB", label: "Mobile-light RAM" },
  { value: "1 GB", label: "Virtual ext4 disk" },
  { value: "x86", label: "Real ELF binaries" },
] as const;

const KEYS_TOP = ["Esc", "Tab", "Ctrl", "Alt"] as const;
const KEYS_BOTTOM = ["←", "↓", "↑", "→"] as const;

const ACADEMY_TOPICS = [
  "Files & Shell",
  "Permissions & Pipes",
  "Search & Logs",
  "JSON & jq",
  "Git & C",
] as const;

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />

      <Navbar />

      <main id="main-content" className="flex-1">
        {/* ================= HERO ================= */}
        <section
          aria-labelledby="hero-heading"
          className="relative bg-canvas pt-12 pb-16 sm:pt-20 sm:pb-24"
        >
          <div className="mx-auto grid w-full max-w-[1180px] grid-cols-1 items-center gap-14 px-4 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
            <div className="min-w-0">
              <p className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-border bg-subtle px-3.5 py-1.5 text-[13px] font-semibold text-ink">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-ink"
                />
                Runs 100% on your device
              </p>

              <h1
                id="hero-heading"
                className="mb-5 text-[clamp(2.6rem,6.4vw,4.9rem)] leading-[0.98] font-extrabold tracking-[-0.045em] text-ink"
              >
                A real Linux machine, right in your browser tab.
              </h1>

              <p className="mb-8 max-w-[50ch] text-[17px] leading-relaxed text-secondary">
                Alpine Linux with a C compiler, Python, git and vim, awake in
                under a second. No install, no sign-up, no server. Try{" "}
                <code className={INLINE_CODE_CLASS}>tcc</code>,{" "}
                <code className={INLINE_CODE_CLASS}>python3</code> or{" "}
                <code className={INLINE_CODE_CLASS}>fastfetch</code> in the
                terminal beside this text.
              </p>

              <div className="mb-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <a
                  data-launch-url=""
                  href={SITE.terminalUrl}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-7 py-3.5 text-[15px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <span>Open the terminal</span>
                  <svg
                    viewBox="0 0 20 20"
                    width="16"
                    height="16"
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
                <a
                  href="#how-it-works"
                  className="inline-flex items-center justify-center rounded-full border border-border bg-canvas px-7 py-3.5 text-[15px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-secondary hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  See how it works
                </a>
              </div>

              <dl
                aria-label="Key facts"
                className="grid max-w-[460px] grid-cols-3 gap-3"
              >
                {HERO_STATS.map((stat) => (
                  <div
                    key={stat.label}
                    className="flex flex-col-reverse rounded-2xl border border-border bg-subtle px-4 py-3.5"
                  >
                    <dt className="mt-0.5 text-xs text-secondary">
                      {stat.label}
                    </dt>
                    <dd className="text-2xl font-extrabold tracking-tight text-ink">
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="min-w-0 pt-4 lg:pt-0">
              <HeroTerminal />
            </div>
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section
          id="how-it-works"
          aria-labelledby="how-heading"
          className="scroll-mt-20 border-y border-border-soft bg-subtle py-16 sm:py-24"
        >
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
            <div className="mb-10 max-w-[660px]">
              <h2 id="how-heading" className={H2_CLASS}>
                No cloud server. Just smart browser engineering.
              </h2>
              <p className="text-[16.5px] leading-relaxed text-secondary">
                Here is exactly what happens from the moment you open{" "}
                <strong className="font-semibold text-ink">
                  terminal.golinux.app
                </strong>
                , even if you have never touched Linux before.
              </p>
            </div>

            <HowItWorks />
          </div>
        </section>

        {/* ================= TOOLS ================= */}
        <section
          id="tools"
          aria-labelledby="tools-heading"
          className="scroll-mt-20 bg-canvas py-16 sm:py-24"
        >
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
            <div className="mb-10 max-w-[660px]">
              <h2 id="tools-heading" className={H2_CLASS}>
                Real Alpine Linux tools, ready to run.
              </h2>
              <p className="text-[16.5px] leading-relaxed text-secondary">
                Not a fake JavaScript shell. Real x86 binaries running on Linux
                6.12 with musl.
              </p>
            </div>

            <ToolsExplorer />
          </div>
        </section>

        {/* ================= FEATURES ================= */}
        <section
          id="features"
          aria-labelledby="features-heading"
          className="scroll-mt-20 border-y border-border-soft bg-subtle py-16 sm:py-24"
        >
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
            <div className="mb-10 max-w-[660px]">
              <h2 id="features-heading" className={H2_CLASS}>
                Fast, private, and actually usable on phones.
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* Mobile */}
              <article className="relative min-w-0 overflow-hidden rounded-[28px] border border-border bg-canvas p-7 text-ink sm:p-8 lg:col-span-2">
                <div className="relative grid gap-8 sm:grid-cols-[1.1fr_0.9fr] sm:items-center">
                  <div>
                    <h3 className="mb-3 text-[26px] leading-tight font-extrabold tracking-[-0.03em] text-ink">
                      A real terminal on your phone
                    </h3>
                    <p className="text-[15px] leading-relaxed text-secondary">
                      A two-row touch key bar with{" "}
                      <code className={INLINE_CODE_CLASS}>Ctrl</code>,{" "}
                      <code className={INLINE_CODE_CLASS}>Alt</code>,{" "}
                      <code className={INLINE_CODE_CLASS}>Esc</code>,{" "}
                      <code className={INLINE_CODE_CLASS}>Tab</code> and arrows
                      latches cleanly with your phone&apos;s native keyboard.
                      Rotate the screen and the terminal resizes to fit.
                    </p>
                  </div>
                  <div
                    aria-hidden="true"
                    className="flex flex-col items-start gap-2.5 sm:items-end"
                  >
                    <div className="flex gap-2">
                      {KEYS_TOP.map((key) => (
                        <span
                          key={key}
                          className="keycap"
                          data-latched={key === "Ctrl" ? "true" : "false"}
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      {KEYS_BOTTOM.map((key) => (
                        <span key={key} className="keycap">
                          {key}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </article>

              {/* Privacy */}
              <article className="min-w-0 rounded-[22px] border border-border bg-canvas p-7">
                <div
                  aria-hidden="true"
                  className="mb-5 inline-flex size-12 items-center justify-center rounded-2xl border border-border bg-subtle text-ink"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="24"
                    height="24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <polyline points="9 12 11.5 14.5 15.5 9.5" />
                  </svg>
                </div>
                <h3 className="mb-2 text-[22px] font-extrabold tracking-[-0.025em] text-ink">
                  Nothing leaves your tab
                </h3>
                <p className="text-sm leading-relaxed text-secondary">
                  Zero analytics, zero tracking, and guest networking is off by
                  design. Break anything, then hit{" "}
                  <strong className="font-semibold text-ink">Reset</strong> for
                  a clean Alpine in a second.
                </p>
              </article>

              {/* File transfer */}
              <article className="min-w-0 rounded-[22px] border border-border bg-canvas p-7">
                <div
                  aria-hidden="true"
                  className="mb-5 flex items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-subtle p-4 font-mono text-xs"
                >
                  <span className="rounded-md border border-border bg-canvas px-2 py-1 text-ink">
                    notes.md
                  </span>
                  <span className="rounded-md border border-border bg-canvas px-2 py-1 text-ink">
                    main.c
                  </span>
                  <span className="ml-auto text-secondary">~ (/root)</span>
                </div>
                <h3 className="mb-2 text-[22px] font-extrabold tracking-[-0.025em] text-ink">
                  Drop files in, download straight out
                </h3>
                <p className="text-sm leading-relaxed text-secondary">
                  Drag files onto the terminal to drop them directly into{" "}
                  <code className={INLINE_CODE_CLASS}>~</code> (auto-saved), and
                  click <strong className="font-semibold text-ink">Download</strong>{" "}
                  to export any file straight back to your device.
                </p>
              </article>

              {/* Specs */}
              <article
                aria-label="Virtual machine specifications"
                className="flex min-w-0 items-center rounded-[22px] border border-border bg-canvas p-7 lg:col-span-2"
              >
                <dl className="grid w-full grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-4">
                  {SPECS.map((spec) => (
                    <div key={spec.label} className="flex flex-col-reverse">
                      <dt className="mt-1 text-xs text-secondary">
                        {spec.label}
                      </dt>
                      <dd className="text-[28px] leading-none font-extrabold tracking-[-0.03em] text-ink">
                        {spec.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            </div>
          </div>
        </section>

        {/* ================= GOLINUX ACADEMY ================= */}
        <section
          id="academy"
          aria-labelledby="academy-heading"
          className="scroll-mt-20 bg-canvas pt-16 pb-4 sm:pt-24 sm:pb-6"
        >
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
            <div className="overflow-hidden rounded-[32px] border border-border bg-subtle p-7 sm:p-10 lg:p-12">
              <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.12fr_0.88fr] lg:gap-12">
                <div className="min-w-0">
                  <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-canvas px-3.5 py-1 text-[12.5px] font-semibold text-ink">
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-full bg-emerald-500"
                    />
                    GoLinux Academy · Free interactive wargame
                  </p>

                  <h2 id="academy-heading" className={H2_CLASS}>
                    Wanna learn Linux by doing?
                  </h2>

                  <p className="mb-6 max-w-[54ch] text-[16px] leading-relaxed text-secondary">
                    Put this browser VM to work with{" "}
                    <strong className="font-semibold text-ink">
                      Deep dive into Linux
                    </strong>{" "}
                    — progressive, hands-on filesystem puzzles from beginner to
                    expert. Explore directories, uncover hidden secrets with
                    real{" "}
                    <code className={INLINE_CODE_CLASS}>ls</code>,{" "}
                    <code className={INLINE_CODE_CLASS}>find</code>,{" "}
                    <code className={INLINE_CODE_CLASS}>grep</code>,{" "}
                    <code className={INLINE_CODE_CLASS}>jq</code>, and{" "}
                    <code className={INLINE_CODE_CLASS}>git</code> commands, and
                    optionally sync progress across devices.
                  </p>

                  <ul
                    aria-label="GoLinux Academy topics"
                    className="mb-7 flex flex-wrap gap-2"
                  >
                    {ACADEMY_TOPICS.map((topic) => (
                      <li
                        key={topic}
                        className="inline-flex items-center rounded-full border border-border bg-canvas px-3 py-1 text-xs font-medium text-ink"
                      >
                        {topic}
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                    <a
                      href={SITE.academyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-7 py-3.5 text-[15px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-subtle"
                    >
                      <span>Start GoLinux Academy</span>
                      <svg
                        viewBox="0 0 20 20"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4 10h12M11 5l5 5-5 5" />
                      </svg>
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    <a
                      href={`${SITE.academyUrl}/beginner`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-full border border-border bg-canvas px-6 py-3.5 text-[14.5px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-secondary hover:bg-canvas/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-subtle"
                    >
                      Start Beginner — Free
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </div>
                </div>

                <div
                  aria-hidden="true"
                  className="overflow-hidden rounded-[22px] border border-border bg-[#0b0d0e] text-[#ededed] shadow-lg"
                >
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full bg-[#ff5f56]" />
                      <span className="size-2.5 rounded-full bg-[#ffbd2e]" />
                      <span className="size-2.5 rounded-full bg-[#27c93f]" />
                    </div>
                    <span className="font-mono text-[11.5px] text-[#9aa39b]">
                      academy.golinux.app
                    </span>
                  </div>

                  <div className="space-y-2.5 p-5 font-mono text-[13px] leading-relaxed">
                    <p className="text-[11px] font-semibold tracking-wider text-[#c8f04a] uppercase">
                      Mission · Hidden in Plain Sight
                    </p>
                    <p>
                      <span className="text-[#c8f04a]">$</span> ls -la
                    </p>
                    <p className="text-[#9aa39b]">
                      -rw-r--r--&nbsp;&nbsp;1 root root&nbsp;&nbsp;&nbsp;68 .note
                    </p>
                    <p>
                      <span className="text-[#c8f04a]">$</span> cat .note
                    </p>
                    <p className="text-[#9aa39b]">
                      Nice find! Submit this secret to unlock the next challenge:
                    </p>
                    <p className="inline-block rounded-lg border border-[#c8f04a]/35 bg-[#c8f04a]/12 px-2.5 py-1 font-semibold text-[#c8f04a]">
                      GLAC-████-████-████-████
                    </p>
                  </div>

                  <div className="flex items-center justify-between border-t border-white/10 bg-white/[0.03] px-5 py-3 text-xs text-[#9aa39b]">
                    <span className="font-medium text-emerald-400">
                      ✓ Interactive challenges · ∞ retries · Free
                    </span>
                    <span className="font-mono text-[11px]">Alpine Linux</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= FINAL CTA ================= */}
        <section
          aria-labelledby="cta-heading"
          className="bg-canvas pt-16 pb-20 sm:pt-20 sm:pb-28"
        >
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
            <div className="relative overflow-hidden rounded-[32px] border border-border bg-subtle px-6 py-16 text-center text-ink sm:py-20">
              <p
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-3 left-6 max-w-full font-mono text-[clamp(1.5rem,7vw,5rem)] font-bold text-ink/[0.045] select-none"
              >
                root@golinux:~#
              </p>
              <div className="relative z-10">
                <h2
                  id="cta-heading"
                  className="mb-3 text-[clamp(2rem,5vw,3.6rem)] leading-[1.02] font-extrabold tracking-[-0.04em] text-ink"
                >
                  Ready to open a shell?
                </h2>
                <p className="mx-auto mb-8 max-w-[44ch] text-[17px] font-medium text-secondary">
                  No sign-up, no install, no waiting. Alpine Linux boots in
                  your browser right now.
                </p>
                <a
                  data-launch-url=""
                  href={SITE.terminalUrl}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-8 py-4 text-base font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-subtle"
                >
                  <span>Open GoLinux</span>
                  <svg
                    viewBox="0 0 20 20"
                    width="16"
                    height="16"
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
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
