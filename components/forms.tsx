"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  createOpportunity,
  createTask,
  saveContact,
  type ActionResult,
} from "@/app/(app)/actions";
import { useModalClose } from "@/components/modal";
import { STAGES, STAGE_LABELS, type Contact } from "@/types";

function useSubmit(action: (fd: FormData) => Promise<ActionResult>, success: string, onDone?: () => void) {
  const router = useRouter();
  const modalClose = useModalClose();
  const done = onDone ?? modalClose;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (fd: FormData) => {
    setError(null);
    start(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(success);
      done?.();
      router.refresh();
    });
  };
  return { submit, pending, error, cancel: done };
}

function Footer({ pending, error, label, onCancel }: { pending: boolean; error: string | null; label: string; onCancel?: () => void }) {
  return (
    <>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} {label}
        </button>
      </div>
    </>
  );
}

export function ContactForm({ contact, onDone }: { contact?: Contact; onDone?: () => void }) {
  const { submit, pending, error, cancel } = useSubmit(
    (fd) => saveContact(fd, contact?.id),
    contact ? "Contact updated" : "Contact created",
    onDone,
  );
  return (
    <form action={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="c-name">Name *</label>
        <input id="c-name" name="name" className="input" defaultValue={contact?.name} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="c-email">Email</label>
          <input id="c-email" name="email" type="email" className="input" defaultValue={contact?.email ?? ""} />
        </div>
        <div>
          <label className="label" htmlFor="c-phone">Phone</label>
          <input id="c-phone" name="phone" className="input" defaultValue={contact?.phone ?? ""} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="c-company">Company</label>
        <input id="c-company" name="company" className="input" defaultValue={contact?.company ?? ""} />
      </div>
      <div>
        <label className="label" htmlFor="c-notes">Notes</label>
        <textarea id="c-notes" name="notes" rows={3} className="input" defaultValue={contact?.notes ?? ""} />
      </div>
      <Footer pending={pending} error={error} label={contact ? "Save changes" : "Create contact"} onCancel={cancel} />
    </form>
  );
}

export function OpportunityForm({
  contacts,
  defaultContactId,
  onDone,
}: {
  contacts: Pick<Contact, "id" | "name" | "company">[];
  defaultContactId?: string;
  onDone?: () => void;
}) {
  const { submit, pending, error, cancel } = useSubmit(createOpportunity, "Opportunity created", onDone);
  return (
    <form action={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="o-title">Title *</label>
        <input id="o-title" name="title" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="o-contact">Contact *</label>
        <select id="o-contact" name="contact_id" className="input" defaultValue={defaultContactId ?? ""} required>
          <option value="" disabled>Select a contact…</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.company ? ` — ${c.company}` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="o-value">Value (USD)</label>
          <input id="o-value" name="value" type="number" min={0} step="0.01" defaultValue={0} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="o-stage">Stage</label>
          <select id="o-stage" name="stage" className="input" defaultValue="new">
            {STAGES.map((s) => (
              <option key={s} value={s}>{STAGE_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="o-notes">Notes</label>
        <textarea id="o-notes" name="notes" rows={2} className="input" />
      </div>
      <Footer pending={pending} error={error} label="Create opportunity" onCancel={cancel} />
    </form>
  );
}

export function TaskForm({
  contacts,
  opportunities,
  defaultContactId,
  defaultOpportunityId,
  onDone,
}: {
  contacts: Pick<Contact, "id" | "name">[];
  opportunities: { id: string; title: string }[];
  defaultContactId?: string;
  defaultOpportunityId?: string;
  onDone?: () => void;
}) {
  // datetime-local has no timezone; convert to an ISO instant in the browser.
  const { submit, pending, error, cancel } = useSubmit(
    (fd) => {
      const local = String(fd.get("due_at") ?? "");
      if (local) fd.set("due_at", new Date(local).toISOString());
      return createTask(fd);
    },
    "Task created",
    onDone,
  );
  return (
    <form action={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="t-title">Title *</label>
        <input id="t-title" name="title" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="t-due">Due *</label>
        <input id="t-due" name="due_at" type="datetime-local" className="input" required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="t-contact">Contact</label>
          <select id="t-contact" name="contact_id" className="input" defaultValue={defaultContactId ?? ""}>
            <option value="">None</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="t-opp">Opportunity</label>
          <select id="t-opp" name="opportunity_id" className="input" defaultValue={defaultOpportunityId ?? ""}>
            <option value="">None</option>
            {opportunities.map((o) => (
              <option key={o.id} value={o.id}>{o.title}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="t-desc">Description</label>
        <textarea id="t-desc" name="description" rows={2} className="input" />
      </div>
      <Footer pending={pending} error={error} label="Create task" onCancel={cancel} />
    </form>
  );
}
