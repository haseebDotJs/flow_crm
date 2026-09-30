import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/badge";
import { ContactForm, OpportunityForm, TaskForm } from "@/components/forms";
import { Modal } from "@/components/modal";
import { EmptyState, ErrorState } from "@/components/states";
import { TaskList } from "@/components/task-list";
import { createClient } from "@/lib/supabase/server";
import { STAGE_STYLES, formatCurrency, formatDate } from "@/lib/utils";
import { STAGE_LABELS, type Contact, type Opportunity, type Task } from "@/types";

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // A malformed id is simply "not found".
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [contact, opps, tasks] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", id).maybeSingle(),
    supabase.from("opportunities").select("*").eq("contact_id", id).order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("*, contacts(id, name), opportunities(id, title)")
      .eq("contact_id", id)
      .order("due_at", { ascending: true, nullsFirst: false }),
  ]);

  if (contact.error || opps.error || tasks.error) {
    return <ErrorState message={`Could not load contact: ${(contact.error || opps.error || tasks.error)!.message}`} />;
  }
  if (!contact.data) notFound();

  const c = contact.data as Contact;
  const opportunities = (opps.data ?? []) as Opportunity[];
  const taskRows = (tasks.data ?? []) as unknown as Task[];

  return (
    <div className="space-y-6">
      <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" /> Contacts
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{c.name}</h1>
            <p className="text-sm text-slate-500">{c.company ?? "No company"}</p>
          </div>
          <Modal title="Edit contact" triggerLabel="Edit" triggerClassName="btn-secondary" triggerIcon={<Pencil className="h-4 w-4" />}>
            <ContactForm contact={c} />
          </Modal>
        </div>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Email</dt><dd className="font-medium">{c.email ?? "—"}</dd></div>
          <div><dt className="text-slate-500">Phone</dt><dd className="font-medium">{c.phone ?? "—"}</dd></div>
          <div><dt className="text-slate-500">Added</dt><dd className="font-medium">{formatDate(c.created_at)}</dd></div>
        </dl>
        {c.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-600">{c.notes}</p>}
      </div>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Opportunities</h2>
          <Modal title="New opportunity" triggerLabel="Add" triggerClassName="btn-secondary !py-1" triggerIcon={<Plus className="h-4 w-4" />}>
            <OpportunityForm contacts={[c]} defaultContactId={c.id} />
          </Modal>
        </div>
        {opportunities.length === 0 ? (
          <div className="p-4"><EmptyState title="No opportunities for this contact" /></div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {opportunities.map((o) => (
              <li key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <Link href={`/opportunities/${o.id}`} className="font-medium text-indigo-600 hover:underline">{o.title}</Link>
                <span className="flex items-center gap-3">
                  <span className="text-slate-600">{formatCurrency(o.value)}</span>
                  <Badge className={STAGE_STYLES[o.stage]}>{STAGE_LABELS[o.stage]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Tasks</h2>
          <Modal title="New task" triggerLabel="Add" triggerClassName="btn-secondary !py-1" triggerIcon={<Plus className="h-4 w-4" />}>
            <TaskForm
                contacts={[c]}
                opportunities={opportunities}
                defaultContactId={c.id}
              />
          </Modal>
        </div>
        {taskRows.length === 0 ? (
          <div className="p-4"><EmptyState title="No tasks for this contact" /></div>
        ) : (
          <TaskList tasks={taskRows} />
        )}
      </section>
    </div>
  );
}
