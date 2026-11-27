"use client";

import { useEffect, useState } from "react";

const MAX_LENGTH = 64;

/**
 * Displays the current URL pathname on the client without risking SSR/hydration mismatch.
 */
export function CurrentRoutePath() {
  const [pathname, setPathname] = useState("current location");

  useEffect(() => {
    const raw = window.location.pathname || "/";
    setPathname(
      raw.length > MAX_LENGTH ? `${raw.slice(0, MAX_LENGTH - 3)}...` : raw,
    );
  }, []);

  return <>{pathname}</>;
}
