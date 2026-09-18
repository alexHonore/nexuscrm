"use client";

import type { Locale } from "date-fns";
import { formatDistanceToNow } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useSyncExternalStore } from "react";

/** Display timezone of the whole app (see AGENTS.md). */
const APP_TZ = "America/Toronto";
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * Hydration-safe relative time: renders a stable absolute time until mounted
 * (identical on server and client), then the relative distance ("5 min ago").
 */
export function RelativeTime({ date, locale }: { date: string | Date; locale: Locale }) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);

  const d = typeof date === "string" ? new Date(date) : date;
  return (
    <time dateTime={d.toISOString()}>
      {mounted
        ? formatDistanceToNow(d, { addSuffix: true, locale })
        : formatInTimeZone(d, APP_TZ, "PPp", { locale })}
    </time>
  );
}
