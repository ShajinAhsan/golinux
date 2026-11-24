import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "About & Licenses",
  description:
    "Architecture details, privacy guarantees, open-source components, and software licenses powering GoLinux — Alpine Linux 3.21 in WebAssembly.",
  alternates: {
    canonical: "/about",
  },
  openGraph: {
    title: "About & Licenses — GoLinux",
    description:
      "Open-source components, Alpine Linux 3.21 packages, and privacy architecture behind GoLinux.",
    url: `${SITE.url}/about`,
  },
};

const ABOUT_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "AboutPage",
      "@id": `${SITE.url}/about#page`,
      url: `${SITE.url}/about`,
      name: "About GoLinux",
      description:
        "Architecture, open-source components, and licenses behind GoLinux.",
      isPartOf: { "@id": `${SITE.url}/#website` },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: SITE.url,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "About & Licenses",
          item: `${SITE.url}/about`,
        },
      ],
    },
  ],
};

type Tag = "BSD" | "MIT" | "LGPL" | "GPL" | "PSF" | "Mixed";

interface LicenseCard {
  name: string;
  role: string;
  tag: Tag;
  license: string;
  links: readonly { label: string; href: string }[];
}

const COMPONENTS: readonly LicenseCard[] = [
  {
    name: "v86",
    role: "x86 emulator, WebAssembly",
    tag: "BSD",
    license: "BSD 2-Clause · Copyright (c) 2012, The v86 contributors",
    links: [
      { label: "github.com/copy/v86", href: "https://github.com/copy/v86" },
      { label: "copy.sh/v86", href: "https://copy.sh/v86/" },
      {
        label: "license",
        href: "https://github.com/copy/v86/blob/master/LICENSE",
      },
    ],
  },
  {
    name: "xterm.js",
    role: "terminal component",
    tag: "MIT",
    license:
      "MIT · Copyright (c) 2017-2019, The xterm.js authors; (c) 2014-2016 SourceLair; (c) 2012-2013 Christopher Jeffrey",
    links: [
      { label: "xtermjs.org", href: "https://xtermjs.org/" },
      { label: "source", href: "https://github.com/xtermjs/xterm.js" },
      {
        label: "license",
        href: "https://github.com/xtermjs/xterm.js/blob/master/LICENSE",
      },
    ],
  },
  {
    name: "@xterm/addon-fit",
    role: "terminal sizing addon",
    tag: "MIT",
    license: "MIT · The xterm.js authors",
    links: [
      {
        label: "npm",
        href: "https://www.npmjs.com/package/@xterm/addon-fit",
      },
      {
        label: "source",
        href: "https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit",
      },
    ],
  },
  {
    name: "SeaBIOS",
    role: "x86 BIOS used by the emulator",
    tag: "LGPL",
    license: "LGPL v3",
    links: [
      { label: "seabios.org", href: "https://www.seabios.org/" },
      {
        label: "bundled images",
        href: "https://github.com/copy/v86/tree/master/bios",
      },
    ],
  },
];

interface PackageRow {
  name: string;
  tag: Tag;
  license: string;
  link?: { label: string; href: string };
  wide?: boolean;
}

const PACKAGES: readonly PackageRow[] = [
  {
    name: "Linux kernel 6.12 (linux-virt)",
    tag: "GPL",
    license: "GNU GPL v2",
    link: { label: "kernel.org", href: "https://www.kernel.org/" },
  },
  {
    name: "BusyBox",
    tag: "GPL",
    license: "GNU GPL v2",
    link: { label: "busybox.net", href: "https://busybox.net/" },
  },
  {
    name: "TinyCC (tcc)",
    tag: "LGPL",
    license: "GNU LGPL v2.1",
    link: { label: "bellard.org/tcc", href: "https://bellard.org/tcc/" },
  },
  {
    name: "bash",
    tag: "GPL",
    license: "GNU GPL v3+",
    link: {
      label: "gnu.org/software/bash",
      href: "https://www.gnu.org/software/bash/",
    },
  },
  {
    name: "python3 (Python 3.12)",
    tag: "PSF",
    license: "PSF License",
    link: { label: "python.org", href: "https://www.python.org/" },
  },
  {
    name: "git",
    tag: "GPL",
    license: "GNU GPL v2",
    link: { label: "git-scm.com", href: "https://git-scm.com/" },
  },
  {
    name: "nano, make",
    tag: "GPL",
    license: "GNU GPL v3+",
  },
  {
    name: "fastfetch, tmux, jq, htop, tree, mandoc, less, lsblk, file, zip / unzip, figlet, sl, curl",
    tag: "Mixed",
    license: "MIT / BSD / GPL",
    wide: true,
  },
];

const H2_CLASS =
  "mb-4 text-2xl font-extrabold tracking-[-0.03em] text-ink sm:text-[28px]";

const EXTERNAL_LINK_CLASS =
  "rounded-sm font-medium text-ink underline decoration-border underline-offset-4 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

function ExternalLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={EXTERNAL_LINK_CLASS}
    >
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function LicenseBadge({ tag }: { tag: Tag }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-subtle px-2.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
      {tag}
    </span>
  );
}

export default function AboutPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ABOUT_JSON_LD) }}
      />

      <Navbar />

      <main
        id="main-content"
        className="mx-auto w-full max-w-[880px] flex-1 px-4 py-12 sm:px-6 sm:py-16"
      >
        <nav aria-label="Breadcrumb" className="mb-8 text-[13px] text-secondary">
          <ol className="flex items-center gap-2">
            <li>
              <Link
                href="/"
                className="rounded-sm font-medium transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-medium text-ink">
              About &amp; Licenses
            </li>
          </ol>
        </nav>

        <header className="mb-12 border-b border-border pb-8">
          <h1 className="mb-3 text-[clamp(2.4rem,6vw,4rem)] leading-none font-extrabold tracking-[-0.045em] text-ink">
            About GoLinux
          </h1>
          <p className="max-w-[52ch] text-[17px] leading-relaxed text-secondary">
            An ultra-lightweight Alpine Linux machine, emulated entirely in
            your browser.
          </p>
        </header>

        <section aria-labelledby="what-this-is" className="mb-12">
          <h2 id="what-this-is" className={H2_CLASS}>
            What this is
          </h2>
          <p className="mb-4 max-w-[68ch] text-[16px] leading-relaxed text-secondary">
            GoLinux boots a 32-bit Alpine Linux 3.21 (x86) system with BusyBox
            and TinyCC inside your browser using v86, an x86 emulator written in
            WebAssembly. There is no server process: the machine runs on your
            device. The terminal is xterm.js.
          </p>
          <p className="max-w-[68ch] text-[16px] leading-relaxed text-secondary">
            Networking is disabled. Your files live in this browser&apos;s
            storage and are never uploaded. They survive reloads and closed
            tabs; clearing site data or using Reset removes them.
          </p>
        </section>

        <section aria-labelledby="components" className="mb-12">
          <h2 id="components" className={H2_CLASS}>
            Components and licenses
          </h2>
          <div className="flex flex-col gap-3">
            {COMPONENTS.map((comp) => (
              <article
                key={comp.name}
                className="rounded-2xl border border-border bg-canvas p-5"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h3 className="text-base font-bold text-ink">{comp.name}</h3>
                  <LicenseBadge tag={comp.tag} />
                  <span className="text-sm text-secondary">{comp.role}</span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-secondary">
                  {comp.license}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
                  {comp.links.map((link) => (
                    <ExternalLink
                      key={link.href}
                      label={link.label}
                      href={link.href}
                    />
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="guest-os" className="mb-12">
          <h2 id="guest-os" className={H2_CLASS}>
            Guest operating system
          </h2>
          <article className="rounded-2xl border border-border bg-canvas p-5">
            <h3 className="text-base font-bold text-ink">
              Alpine Linux 3.21 (x86), Linux 6.12 + musl + BusyBox
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-secondary">
              Alpine Linux is built on musl libc (MIT) and BusyBox (GNU GPL v2).
              Source packages and build definitions are publicly available from
              Alpine&apos;s official repositories.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
              <ExternalLink
                label="alpinelinux.org"
                href="https://alpinelinux.org/"
              />
              <ExternalLink
                label="aports source"
                href="https://gitlab.alpinelinux.org/alpine/aports"
              />
              <ExternalLink label="musl libc" href="https://musl.libc.org/" />
            </div>
          </article>
        </section>

        <section aria-labelledby="packages" className="mb-12">
          <h2 id="packages" className={H2_CLASS}>
            Installed packages
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PACKAGES.map((pkg) => (
              <li
                key={pkg.name}
                className={`rounded-2xl border border-border bg-canvas p-4 ${
                  pkg.wide ? "sm:col-span-2" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <strong className="text-[15px] font-bold text-ink">
                    {pkg.name}
                  </strong>
                  <LicenseBadge tag={pkg.tag} />
                </div>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-secondary">
                  <span>{pkg.license}</span>
                  {pkg.link ? (
                    <ExternalLink
                      label={pkg.link.label}
                      href={pkg.link.href}
                    />
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="this-site" className="mb-12">
          <h2 id="this-site" className={H2_CLASS}>
            This site
          </h2>
          <p className="max-w-[68ch] text-[16px] leading-relaxed text-secondary">
            The GoLinux page code, service worker, and image build scripts are
            project-specific. The Alpine Linux image is built directly from
            official Alpine{" "}
            <code className="rounded-md border border-border bg-subtle px-1.5 py-0.5 font-mono text-[0.88em] text-ink">
              apk
            </code>{" "}
            repositories.
          </p>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-5 rounded-3xl border border-border bg-subtle px-6 py-6 text-ink">
          <p className="max-w-[40ch] text-[15px] font-medium text-secondary">
            No analytics, no tracking, no network requests beyond loading the
            app and its disk data.
          </p>
          <a
            href={SITE.terminalUrl}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-subtle"
          >
            <span>Launch terminal</span>
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </main>

      <Footer />
    </>
  );
}
