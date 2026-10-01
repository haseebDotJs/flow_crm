import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
import { Badge } from "@/components/badge";
import { TaskForm } from "@/components/forms";
import { Modal } from "@/components/modal";
import { StageSelect } from "@/components/stage-select";
import { EmptyState, ErrorState } from "@/components/states";
import { TaskList } from "@/components/task-list";
import { createClient } from "@/lib/supabase/server";
import { STAGE_STYLES, formatCurrency, formatDate } from "@/lib/utils";
import { STAGE_LABELS, type Opportunity, type Task } from "@/types";

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();

  const [opp, tasks] = await Promise.all([
    supabase.from("opportunities").select("*, contacts(id, name, company)").eq("id", id).maybeSingle(),
    supabase
      .from("tasks")
      .select("*, contacts(id, name, email), opportunities(id, title), email_templates(id, name)")
      .eq("opportunity_id", id)
      .order("due_at", { ascending: true, nullsFirst: false }),
  ]);

  if (opp.error || tasks.error) {
    return <ErrorState message={`Could not load opportunity: ${(opp.error || tasks.error)!.message}`} />;
  }
  if (!opp.data) notFound();

  const o = opp.data as unknown as Opportunity;
  const taskRows = (tasks.data ?? []) as unknown as Task[];

  return (
    <div className="space-y-6">
      <Link href="/pipeline" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" /> Pipeline
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{o.title}</h1>
            <p className="text-sm text-slate-500">
              {o.contacts ? (
                <Link href={`/contacts/${o.contacts.id}`} className="hover:underline">
                  {o.contacts.name}
                  {o.contacts.company ? ` · ${o.contacts.company}` : ""}
                </Link>
              ) : (
                "No contact"
              )}
            </p>
          </div>
          <Badge className={STAGE_STYLES[o.stage]}>{STAGE_LABELS[o.stage]}</Badge>
        </div>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-slate-500">Value</dt><dd className="font-medium">{formatCurrency(o.value)}</dd></div>
          <div><dt className="mb-1 text-slate-500">Stage</dt><dd><StageSelect id={o.id} stage={o.stage} /></dd></div>
          <div><dt className="text-slate-500">Created</dt><dd className="font-medium">{formatDate(o.created_at)}</dd></div>
          <div><dt className="text-slate-500">Updated</dt><dd className="font-medium">{formatDate(o.updated_at)}</dd></div>
        </dl>
        {o.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-600">{o.notes}</p>}
      </div>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Related tasks</h2>
          <Modal title="New task" triggerLabel="Add" triggerClassName="btn-secondary !py-1" triggerIcon={<Plus className="h-4 w-4" />}>
            <TaskForm
                contacts={o.contacts ? [o.contacts] : []}
                opportunities={[{ id: o.id, title: o.title }]}
                defaultContactId={o.contact_id}
                defaultOpportunityId={o.id}
              />
          </Modal>
        </div>
        {taskRows.length === 0 ? (
          <div className="p-4"><EmptyState title="No tasks for this opportunity" /></div>
        ) : (
          <TaskList tasks={taskRows} />
        )}
      </section>
    </div>
  );
}
