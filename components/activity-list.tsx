import Link from "next/link";
import { ArrowRight, CheckSquare, Kanban, User, Users } from "lucide-react";
import { Badge } from "@/components/badge";
import { STAGE_STYLES, formatDateTime } from "@/lib/utils";
import { STAGE_LABELS, STAGES, type ActivityActor, type ActivityEntry, type Stage } from "@/types";

const ACTOR: Record<ActivityActor, { label: string; cls: string }> = {
  user: { label: "You", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
  voice: { label: "Voice AI", cls: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  automation: { label: "Automation", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  webhook: { label: "Webhook", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

const TYPE = {
  contact: { label: "Contact", icon: Users, cls: "bg-sky-50 text-sky-600" },
  opportunity: { label: "Opportunity", icon: Kanban, cls: "bg-violet-50 text-violet-600" },
  task: { label: "Task", icon: CheckSquare, cls: "bg-amber-50 text-amber-600" },
} as const;

const ACTION: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  stage_changed: "Stage changed",
  completed: "Completed",
  cancelled: "Cancelled",
  reopened: "Reopened",
  rescheduled: "Rescheduled",
  email_sent: "Email sent",
  email_failed: "Email failed",
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v);

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

function StageChip({ stage }: { stage: Stage }) {
  return <Badge className={STAGE_STYLES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

/** What changed, shown next to the item's name. */
function Change({ e }: { e: ActivityEntry }) {
  const m = e.metadata ?? {};
  if (e.action === "stage_changed" && isStage(m.from) && isStage(m.to)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <StageChip stage={m.from} />
        <ArrowRight className="h-3 w-3 text-slate-400" aria-label="to" />
        <StageChip stage={m.to} />
      </span>
    );
  }
  if (e.action === "rescheduled" && str(m.to)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
        <ArrowRight className="h-3 w-3 text-slate-400" aria-label="to" /> {formatDateTime(m.to as string)}
      </span>
    );
  }
  if (e.action === "email_sent" && str(m.to)) {
    return (
      <span className="text-xs text-slate-600">
        to {m.to as string}
        {m.test_mode === true ? " (test mode)" : ""}
      </span>
    );
  }
  if (e.action === "email_failed" && str(m.error)) {
    return <span className="text-xs text-red-600">{(m.error as string).slice(0, 80)}</span>;
  }
  if (e.action === "updated" && Array.isArray(m.changed) && m.changed.length > 0) {
    return <span className="text-xs text-slate-500">({(m.changed as string[]).join(", ").replaceAll("_", " ")})</span>;
  }
  return null;
}

export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {entries.map((e) => {
        const type = TYPE[e.entity_type];
        const Icon = type.icon;
        const link = href(e);
        const actor = ACTOR[e.actor];
        const m = e.metadata ?? {};

        // Older entries (before details were recorded) fall back to the one-line summary.
        const title = str(m.title);
        const contact = str(m.contact);
        const company = str(m.company);
        const deal = str(m.opportunity);
        const name = title ?? e.summary;

        return (
          <li key={e.id} className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-0.5 rounded-md p-1.5 ${type.cls}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>

            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                {type.label} <span aria-hidden>·</span> {ACTION[e.action] ?? e.action}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-slate-900">
                {link ? (
                  <Link href={link} className="hover:text-indigo-600 hover:underline">{name}</Link>
                ) : (
                  <span className={e.action === "deleted" ? "line-through decoration-slate-300" : ""}>{name}</span>
                )}
                <Change e={e} />
              </p>
              {/* who this is about: contact for deals and tasks, company for contacts */}
              {e.entity_type === "contact" && company && <p className="text-xs text-slate-500">{company}</p>}
              {e.entity_type !== "contact" && (contact || deal) && (
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
                  {contact && (
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" aria-hidden /> {contact}
                      {company ? ` · ${company}` : ""}
                    </span>
                  )}
                  {e.entity_type === "task" && deal && (
                    <span>
                      {contact ? "· " : ""}Deal: {deal}
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge className={actor.cls}>{actor.label}</Badge>
              <span className="text-xs text-slate-400" title={new Date(e.created_at).toLocaleString()}>
                {timeAgo(e.created_at)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
