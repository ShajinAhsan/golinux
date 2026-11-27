"use client";

import Link from "next/link";
import { useEffect } from "react";
import StatusScreen from "@/components/StatusScreen";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app error]", error);
  }, [error]);

  return (
    <StatusScreen
      code="500"
      codeClassName="text-[clamp(6.5rem,20vw,14.5rem)]"
      eyebrow="System response / 500"
      title="This page hit a rough edge."
      description="Something went wrong while rendering this page. Try again, or return home."
      actions={
        <>
          <button
            type="button"
            onClick={reset}
            className="inline-flex cursor-pointer items-center justify-center rounded-full bg-ink px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-canvas transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-border bg-canvas px-6 py-3 text-[14px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-secondary hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Return home
          </Link>
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
  );
}
