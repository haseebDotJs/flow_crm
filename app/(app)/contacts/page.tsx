import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { ContactForm } from "@/components/forms";
import { Modal } from "@/components/modal";
import { EmptyState, ErrorState } from "@/components/states";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/types";

export const metadata = { title: "Contacts · FlowCRM" };

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const supabase = await createClient();

  let query = supabase.from("contacts").select("*").order("name");
  // Strip characters that are special in PostgREST filter syntax.
  const term = q.trim().replace(/[%,()*\\]/g, " ").trim();
  if (term) {
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) return <ErrorState message={`Could not load contacts: ${error.message}`} />;
  const contacts = (data ?? []) as Contact[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-slate-500">People and companies you sell to.</p>
        </div>
        <Modal title="New contact" triggerLabel="New contact" triggerIcon={<Plus className="h-4 w-4" />}>
          <ContactForm />
        </Modal>
      </div>

      <form className="relative max-w-sm" role="search">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input name="q" defaultValue={q} placeholder="Search name, email or company…" className="input pl-9" />
      </form>

      {contacts.length === 0 ? (
        <EmptyState
          title={term ? `No contacts match “${term}”` : "No contacts yet"}
          hint={term ? "Try a different search." : "Create your first contact to get started."}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/contacts/${c.id}`} className="text-indigo-600 hover:underline">{c.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{c.company ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{c.email ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{c.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
