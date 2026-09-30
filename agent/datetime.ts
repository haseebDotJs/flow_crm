/** Timezone helpers so the model can speak in local time while we store UTC. */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` from UTC at the given instant: local = utc + offset. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** Used when the model gives a date without a time ("tomorrow"). */
export const DEFAULT_HOUR = 9;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a due date from the model.
 * - With an explicit offset / "Z": honoured as-is.
 * - Without one (e.g. "2026-10-02T10:00:00"): interpreted as wall-clock time in `tz`.
 * - Date only ("2026-10-02"): 9:00 AM in `tz`.
 * Returns null when it cannot be parsed.
 */
export function parseDueAt(input: string, tz: string): Date | null {
  let value = input.trim();
  // Tolerate decoration around the timestamp, e.g. "2026-10-02T09:00:00 (tomorrow)".
  const embedded = /\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/.exec(value);
  if (embedded) value = embedded[0].replace(/\.\d+/, "");
  if (HAS_ZONE.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = NAIVE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const hour = h === undefined ? DEFAULT_HOUR : +h;
  const minute = mi === undefined ? 0 : +mi;
  const wall = Date.UTC(+y, +mo - 1, +d, hour, minute, +(s ?? 0));
  // Reject impossible dates such as 2026-02-31.
  const check = new Date(wall);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || hour > 23 || minute > 59) return null;

  let utc = wall - tzOffsetMs(wall, tz);
  const adjusted = wall - tzOffsetMs(utc, tz); // settle across DST transitions
  if (adjusted !== utc) utc = adjusted;
  return new Date(utc);
}

/** e.g. "Friday, 2026-10-02 10:00" — handed to the model so it can resolve "tomorrow". */
export function describeNow(tz: string, now = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return `${g("weekday")}, ${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** Human-friendly local time for spoken confirmations. */
export function formatSpoken(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
