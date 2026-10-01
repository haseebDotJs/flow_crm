"use client";

import { useSyncExternalStore } from "react";
import { formatDateTime } from "@/lib/utils";

const subscribe = () => () => {};

/**
 * Shows a timestamp in the viewer's own locale and timezone.
 *
 * Formatting a date during render gives different text on the server and in the browser
 * (different locale/timezone), which makes React report a hydration mismatch. Here the server
 * and the hydration pass both render the same stable placeholder (the UTC date); once hydrated,
 * React switches to the browser's formatted value, so there is no mismatch and no stale text.
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatDateTime(iso),
    () => iso.slice(0, 10),
  );
  return <time dateTime={iso}>{text}</time>;
}
