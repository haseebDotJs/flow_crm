import { Plus } from "lucide-react";
import { EmptyState, ErrorState } from "@/components/states";
import { TaskForm } from "@/components/forms";
import { Modal } from "@/components/modal";
import { TaskList } from "@/components/task-list";
import { createClient } from "@/lib/supabase/server";
import { dueBucket } from "@/lib/utils";
import type { Task } from "@/types";

export const metadata = { title: "Tasks · FlowCRM" };

const SECTIONS = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Today" },
  { key: "tomorrow", title: "Tomorrow" },
  { key: "upcoming", title: "Upcoming" },
  { key: "none", title: "No due date" },
] as const;

export default async function TasksPage() {
  const supabase = await createClient();
  const [tasks, contacts, opps] = await Promise.all([
    supabase
      .from("tasks")
      .select("*, contacts(id, name), opportunities(id, title)")
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase.from("contacts").select("id, name").order("name"),
    supabase.from("opportunities").select("id, title").order("title"),
  ]);

  const error = tasks.error || contacts.error || opps.error;
  if (error) return <ErrorState message={`Could not load tasks: ${error.message}`} />;

  const all = (tasks.data ?? []) as unknown as Task[];
  const pending = all.filter((t) => t.status === "pending");
  const closed = all.filter((t) => t.status !== "pending").reverse();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="text-sm text-slate-500">Follow-ups and to-dos.</p>
        </div>
        <Modal title="New task" triggerLabel="New task" triggerIcon={<Plus className="h-4 w-4" />}>
          <TaskForm contacts={contacts.data ?? []} opportunities={opps.data ?? []} />
        </Modal>
      </div>

      {all.length === 0 && <EmptyState title="No tasks yet" hint="Create your first follow-up." />}

      {SECTIONS.map(({ key, title }) => {
        const items = pending.filter((t) => dueBucket(t.due_at) === key);
        if (items.length === 0) return null;
        return (
          <section key={key} className="card">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">
              {title} <span className="font-normal text-slate-400">({items.length})</span>
            </h2>
            <TaskList tasks={items} />
          </section>
        );
      })}

      {closed.length > 0 && (
        <section className="card">
          <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">
            Completed &amp; cancelled <span className="font-normal text-slate-400">({closed.length})</span>
          </h2>
          <TaskList tasks={closed} />
        </section>
      )}
    </div>
  );
}
