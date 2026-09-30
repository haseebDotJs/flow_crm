import Link from "next/link";
import { CheckSquare, Kanban, Users } from "lucide-react";
import { Badge } from "@/components/badge";
import type { ActivityActor, ActivityEntry } from "@/types";

const ACTOR: Record<ActivityActor, { label: string; cls: string }> = {
  user: { label: "You", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
  voice: { label: "Voice AI", cls: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  automation: { label: "Automation", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
};

const ICON = { contact: Users, opportunity: Kanban, task: CheckSquare } as const;

function href(e: ActivityEntry): string | null {
  if (e.action === "deleted") return null;
  if (e.entity_type === "contact") return `/contacts/${e.entity_id}`;
  if (e.entity_type === "opportunity") return `/opportunities/${e.entity_id}`;
  return "/tasks";
}

function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {entries.map((e) => {
        const Icon = ICON[e.entity_type];
        const link = href(e);
        const actor = ACTOR[e.actor];
        return (
          <li key={e.id} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-slate-500">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-900">
                {link ? (
                  <Link href={link} className="hover:text-indigo-600 hover:underline">{e.summary}</Link>
                ) : (
                  e.summary
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-500" title={new Date(e.created_at).toLocaleString()}>
                {timeAgo(e.created_at)}
              </p>
            </div>
            <Badge className={actor.cls}>{actor.label}</Badge>
          </li>
        );
      })}
    </ul>
  );
}
