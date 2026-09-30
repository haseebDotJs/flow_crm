import Link from "next/link";
import { Badge } from "@/components/badge";
import { TaskActions } from "@/components/stage-select";
import { BUCKET_STYLES, dueBucket, formatDateTime } from "@/lib/utils";
import type { Task } from "@/types";

export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {tasks.map((t) => {
        const bucket = t.status === "pending" ? dueBucket(t.due_at) : "none";
        return (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className={`text-sm font-medium ${t.status === "pending" ? "text-slate-900" : "text-slate-400 line-through"}`}>
                {t.title}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {t.contacts && (
                  <Link href={`/contacts/${t.contacts.id}`} className="hover:underline">{t.contacts.name}</Link>
                )}
                {t.contacts && t.opportunities && " · "}
                {t.opportunities && (
                  <Link href={`/opportunities/${t.opportunities.id}`} className="hover:underline">
                    {t.opportunities.title}
                  </Link>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {t.status === "pending" ? (
                <Badge className={BUCKET_STYLES[bucket]}>
                  {bucket === "none" ? "No date" : bucket[0].toUpperCase() + bucket.slice(1)} · {formatDateTime(t.due_at)}
                </Badge>
              ) : (
                <Badge className="bg-slate-100 text-slate-500 ring-slate-200 capitalize">{t.status}</Badge>
              )}
              <TaskActions id={t.id} status={t.status} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
