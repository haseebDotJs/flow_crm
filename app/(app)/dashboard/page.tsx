import Link from "next/link";
import { ErrorState, EmptyState } from "@/components/states";
import { TaskList } from "@/components/task-list";
import { Badge } from "@/components/badge";
import { ActivityList } from "@/components/activity-list";
import { createClient } from "@/lib/supabase/server";
import { STAGE_STYLES, formatCurrency } from "@/lib/utils";
import { STAGES, STAGE_LABELS, type ActivityEntry, type Stage, type Task } from "@/types";

export const metadata = { title: "Dashboard · FlowCRM" };

export default async function DashboardPage() {
  const supabase = await createClient();
  const [contacts, opps, tasks, activity] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }),
    supabase.from("opportunities").select("stage, value"),
    supabase
      .from("tasks")
      .select("*, contacts(id, name), opportunities(id, title)")
      .eq("status", "pending")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(6),
    supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(5),
  ]);

  const error = contacts.error || opps.error || tasks.error || activity.error;
  if (error) return <ErrorState message={`Could not load dashboard: ${error.message}`} />;

  const rows = (opps.data ?? []) as { stage: Stage; value: number }[];
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }])) as Record<
    Stage,
    { count: number; value: number }
  >;
  for (const r of rows) {
    byStage[r.stage].count += 1;
    byStage[r.stage].value += Number(r.value);
  }
  // Open pipeline excludes closed (won/lost) deals.
  const pipelineValue = STAGES.filter((s) => s !== "won" && s !== "lost").reduce(
    (sum, s) => sum + byStage[s].value,
    0,
  );

  const stats = [
    { label: "Total contacts", value: String(contacts.count ?? 0) },
    { label: "Total opportunities", value: String(rows.length) },
    { label: "Open pipeline value", value: formatCurrency(pipelineValue) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-slate-500">Your sales at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="card p-5">
            <p className="text-sm text-slate-500">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold">Pipeline by stage</h2>
            <Link href="/pipeline" className="text-sm text-indigo-600 hover:underline">View pipeline</Link>
          </div>
          <ul className="divide-y divide-slate-100">
            {STAGES.map((s) => (
              <li key={s} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <Badge className={STAGE_STYLES[s]}>{STAGE_LABELS[s]}</Badge>
                <span className="text-slate-500">
                  {byStage[s].count} · <span className="font-medium text-slate-900">{formatCurrency(byStage[s].value)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold">Upcoming follow-ups</h2>
            <Link href="/tasks" className="text-sm text-indigo-600 hover:underline">All tasks</Link>
          </div>
          {tasks.data && tasks.data.length > 0 ? (
            <TaskList tasks={tasks.data as unknown as Task[]} />
          ) : (
            <div className="p-4"><EmptyState title="No pending follow-ups" hint="Create one from the Tasks page or ask the Voice AI." /></div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Link href="/activity" className="text-sm text-indigo-600 hover:underline">View all</Link>
        </div>
        {activity.data && activity.data.length > 0 ? (
          <ActivityList entries={activity.data as ActivityEntry[]} />
        ) : (
          <div className="p-4"><EmptyState title="No activity yet" /></div>
        )}
      </section>
    </div>
  );
}
