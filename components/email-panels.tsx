"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteTemplate, saveEmailSettings, saveTemplate } from "@/app/(app)/email/actions";
import { Badge } from "@/components/badge";
import { Modal, useModalClose } from "@/components/modal";
import { TEMPLATE_VARIABLES, renderTemplate, sampleVars } from "@/lib/email-template";
import { LocalTime } from "@/components/local-time";
import type { EmailLogEntry, EmailTemplate } from "@/types";

// ---------------------------------------------------------------------- status
export function StatusCard({
  providerConfigured,
  schedulerActive,
}: {
  providerConfigured: boolean;
  schedulerActive: boolean;
}) {
  const row = (ok: boolean, label: string, hint: string) => (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <Check className="mt-0.5 h-4 w-4 text-emerald-600" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" aria-hidden />
      )}
      <span>
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-xs text-slate-500">{hint}</span>
      </span>
    </li>
  );
  return (
    <ul className="space-y-2 p-4">
      {row(
        providerConfigured,
        providerConfigured ? "Email provider connected" : "Email provider not connected",
        providerConfigured ? "Emails are sent through Resend." : "Add RESEND_API_KEY to .env.local and run npm run email:setup.",
      )}
      {row(
        schedulerActive,
        schedulerActive ? "Scheduler running" : "Scheduler not running",
        schedulerActive ? "Checks every minute for follow-ups that are due." : "The pg_cron job is missing; re-run the migrations.",
      )}
    </ul>
  );
}

// -------------------------------------------------------------------- settings
export function EmailSettings({
  testMode,
  testRecipient,
  loginEmail,
}: {
  testMode: boolean;
  testRecipient: string | null;
  loginEmail: string;
}) {
  const [on, setOn] = useState(testMode);
  const [recipient, setRecipient] = useState(testRecipient ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const save = (nextOn: boolean) =>
    start(async () => {
      setError(null);
      const res = await saveEmailSettings({ testMode: nextOn, testRecipient: recipient });
      if (res.ok) {
        setOn(nextOn);
        toast.success(nextOn ? "Test mode on" : "Test mode off: emails go to your contacts");
      } else setError(res.error);
    });

  return (
    <div className="space-y-3 p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            if (!next && !confirm("Turn test mode off? Automated emails will go to your contacts' real addresses.")) return;
            save(next);
          }}
        />
        <span>
          <span className="text-sm font-medium">Test mode</span>
          <span className="block text-xs text-slate-500">
            {on
              ? "Every email goes to the address below instead of the contact, with the intended recipient in the subject."
              : "Emails are sent to your contacts' real addresses."}
          </span>
        </span>
      </label>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          save(on);
        }}
      >
        <input
          className="input"
          type="email"
          placeholder={loginEmail}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          aria-label="Test recipient email"
        />
        <button type="submit" className="btn-secondary shrink-0" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Save recipient
        </button>
      </form>
      <p className="text-xs text-slate-500">
        Test emails go to <strong>{recipient || loginEmail}</strong>. With Resend&apos;s free sandbox sender this must be
        the email address of your Resend account.
      </p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------- templates
function TemplateForm({ template }: { template?: EmailTemplate }) {
  const close = useModalClose();
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<"subject" | "body">("body");

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    if (target === "subject") {
      const el = subjectRef.current;
      const [a, b] = [el?.selectionStart ?? subject.length, el?.selectionEnd ?? subject.length];
      setSubject(subject.slice(0, a) + token + subject.slice(b));
    } else {
      const el = bodyRef.current;
      const [a, b] = [el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length];
      setBody(body.slice(0, a) + token + body.slice(b));
    }
  };

  const vars = sampleVars();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await saveTemplate({ name, subject, body }, template?.id);
          if (res.ok) {
            toast.success(template ? "Template updated" : "Template created");
            close?.();
          } else setError(res.error);
        });
      }}
    >
      <div>
        <label className="label" htmlFor="tpl-name">Name</label>
        <input id="tpl-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      </div>
      <div>
        <label className="label" htmlFor="tpl-subject">Subject</label>
        <input
          id="tpl-subject"
          ref={subjectRef}
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onFocus={() => setTarget("subject")}
          maxLength={200}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="tpl-body">Body</label>
        <textarea
          id="tpl-body"
          ref={bodyRef}
          className="input font-mono text-xs"
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setTarget("body")}
          maxLength={5000}
          required
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Insert into {target}:</span>
          {TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
              onClick={() => insert(v.key)}
              title={`${v.label}, e.g. “${v.sample}”`}
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Preview with sample data</p>
        <p className="text-sm font-medium">{renderTemplate(subject, vars) || "—"}</p>
        <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-slate-700">{renderTemplate(body, vars) || "—"}</pre>
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={() => close?.()}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} {template ? "Save changes" : "Create template"}
        </button>
      </div>
    </form>
  );
}

export function NewTemplateButton() {
  return (
    <Modal title="New template" triggerLabel="New template" triggerIcon={<Plus className="h-4 w-4" />} wide>
      <TemplateForm />
    </Modal>
  );
}

export function TemplateList({ templates }: { templates: EmailTemplate[] }) {
  const [pending, start] = useTransition();
  return (
    <ul className="divide-y divide-slate-100">
      {templates.map((t) => (
        <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">{t.name}</p>
            <p className="truncate text-xs text-slate-500">Subject: {t.subject}</p>
            <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-slate-400">{t.body}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Modal
              title="Edit template"
              triggerLabel="Edit"
              triggerClassName="btn-secondary !px-2.5 !py-1 text-xs"
              triggerIcon={<Pencil className="h-3 w-3" />}
              wide
            >
              <TemplateForm template={t} />
            </Modal>
            <button
              type="button"
              className="btn-danger !px-2.5 !py-1 text-xs"
              disabled={pending}
              onClick={() => {
                if (!confirm(`Delete “${t.name}”? Follow-ups using it will lose their template.`)) return;
                start(async () => {
                  const res = await deleteTemplate(t.id);
                  if (res.ok) toast.success("Template deleted");
                  else toast.error(res.error);
                });
              }}
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------ log
export function EmailLogList({ entries }: { entries: EmailLogEntry[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{e.subject}</p>
            <p className="text-xs text-slate-500">
              To {e.to_email}
              {e.test_mode && e.intended_email ? ` (test mode, intended for ${e.intended_email})` : ""} ·{" "}
              <LocalTime iso={e.created_at} />
            </p>
            {e.status === "failed" && e.error && <p className="mt-0.5 text-xs text-red-600">{e.error}</p>}
          </div>
          <Badge
            className={
              e.status === "sent"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : e.status === "failed"
                  ? "bg-red-50 text-red-700 ring-red-200"
                  : "bg-indigo-50 text-indigo-700 ring-indigo-200"
            }
          >
            {e.status === "sent" ? "Sent" : e.status === "failed" ? "Failed" : "Sending…"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
