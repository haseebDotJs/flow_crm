import Link from "next/link";
import { Plus } from "lucide-react";
import { OpportunityForm } from "@/components/forms";
import { Modal } from "@/components/modal";
import { StageSelect } from "@/components/stage-select";
import { EmptyState, ErrorState } from "@/components/states";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";
import { STAGES, STAGE_LABELS, type Opportunity } from "@/types";

export const metadata = { title: "Pipeline · FlowCRM" };

export default async function PipelinePage() {
  const supabase = await createClient();
  const [opps, contacts] = await Promise.all([
    supabase
      .from("opportunities")
      .select("*, contacts(id, name, company)")
      .order("updated_at", { ascending: false }),
    supabase.from("contacts").select("id, name, company").order("name"),
  ]);

  const error = opps.error || contacts.error;
  if (error) return <ErrorState message={`Could not load pipeline: ${error.message}`} />;

  const rows = (opps.data ?? []) as unknown as Opportunity[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          <p className="text-sm text-slate-500">Change a deal&apos;s stage with the dropdown on each card.</p>
        </div>
        <Modal title="New opportunity" triggerLabel="New opportunity" triggerIcon={<Plus className="h-4 w-4" />}>
          <OpportunityForm contacts={contacts.data ?? []} />
        </Modal>
      </div>

      {rows.length === 0 && (contacts.data ?? []).length === 0 ? (
        <EmptyState title="Nothing in your pipeline yet" hint="Create a contact first, then add an opportunity." />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {STAGES.map((stage) => {
            const items = rows.filter((o) => o.stage === stage);
            const total = items.reduce((s, o) => s + Number(o.value), 0);
            return (
              <section key={stage} aria-label={STAGE_LABELS[stage]} className="w-72 shrink-0 rounded-xl bg-slate-100/70 p-3">
                <div className="mb-3 flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold">
                    {STAGE_LABELS[stage]} <span className="font-normal text-slate-400">{items.length}</span>
                  </h2>
                  <span className="text-xs text-slate-500">{formatCurrency(total)}</span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">No deals</p>}
                  {items.map((o) => (
                    <article key={o.id} className="card space-y-2 p-3">
                      <Link href={`/opportunities/${o.id}`} className="block text-sm font-medium text-slate-900 hover:text-indigo-600">
                        {o.title}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {o.contacts?.name}
                        {o.contacts?.company ? ` · ${o.contacts.company}` : ""}
                      </p>
                      <p className="text-sm font-semibold">{formatCurrency(o.value)}</p>
                      <StageSelect id={o.id} stage={o.stage} />
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
