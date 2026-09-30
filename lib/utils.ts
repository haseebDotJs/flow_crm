import type { Stage } from "@/types";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function formatCurrency(value: number | string | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "No due date";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type DueBucket = "overdue" | "today" | "tomorrow" | "upcoming" | "none";

export function dueBucket(iso: string | null, now = new Date()): DueBucket {
  if (!iso) return "none";
  const due = new Date(iso);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + 86_400_000);
  const startDayAfter = new Date(startToday.getTime() + 2 * 86_400_000);
  if (due < startToday) return "overdue";
  if (due < startTomorrow) return "today";
  if (due < startDayAfter) return "tomorrow";
  return "upcoming";
}

export const BUCKET_STYLES: Record<DueBucket, string> = {
  overdue: "bg-red-50 text-red-700 ring-red-200",
  today: "bg-amber-50 text-amber-700 ring-amber-200",
  tomorrow: "bg-sky-50 text-sky-700 ring-sky-200",
  upcoming: "bg-slate-100 text-slate-600 ring-slate-200",
  none: "bg-slate-100 text-slate-500 ring-slate-200",
};

export const STAGE_STYLES: Record<Stage, string> = {
  new: "bg-slate-100 text-slate-700 ring-slate-200",
  qualified: "bg-sky-50 text-sky-700 ring-sky-200",
  proposal: "bg-violet-50 text-violet-700 ring-violet-200",
  negotiation: "bg-amber-50 text-amber-700 ring-amber-200",
  won: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  lost: "bg-red-50 text-red-700 ring-red-200",
};
