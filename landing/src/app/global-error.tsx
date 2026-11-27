"use client";

import { Bricolage_Grotesque, JetBrains_Mono } from "next/font/google";
import { useEffect } from "react";
import StatusScreen from "@/components/StatusScreen";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-bricolage",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global error]", error);
  }, [error]);

  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased selection:bg-ink selection:text-canvas">
        <StatusScreen
          code="500"
          codeClassName="text-[clamp(6.5rem,20vw,14.5rem)]"
          eyebrow="System response / 500"
          title="The page hit a rough edge."
          description="Something went wrong before the page could render. Try again, or return home."
          actions={
            <>
              <button
                type="button"
                onClick={reset}
                className="inline-flex cursor-pointer items-center justify-center rounded-full bg-ink px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="inline-flex items-center justify-center rounded-full border border-border bg-canvas px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-secondary hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Return home
              </a>
            </>
          }
          command="inspect failure"
          errorLabel="render failed"
          rows={[
            { label: "status", value: "recoverable" },
            { label: "action", value: "retry or return home" },
          ]}
          signal="signal interrupted / retrying"
          dotColor="#d9483b"
        />
      </body>
    </html>
  );
}
