"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Mail, Pencil, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  getEmailProgress,
  runAutomationNow,
  setTaskEmail,
  type EmailProgress,
} from "@/app/(app)/email/actions";
import { Badge } from "@/components/badge";
import { Modal, useModalClose } from "@/components/modal";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/types";

const POLL_MS = 1200;
const MAX_WAIT_MS = 45_000;

type Phase = "idle" | "processing" | "done" | "failed";

function Step({ state, label, detail }: { state: "wait" | "run" | "ok" | "bad"; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-0.5">
        {state === "ok" && <Check className="h-4 w-4 text-emerald-600" aria-hidden />}
        {state === "run" && <Loader2 className="h-4 w-4 animate-spin text-indigo-600" aria-hidden />}
        {state === "bad" && <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden />}
        {state === "wait" && <span className="block h-4 w-4 rounded-full border border-slate-300" aria-hidden />}
      </span>
      <span className={state === "wait" ? "text-slate-400" : "text-slate-800"}>
        {label}
        {detail && <span className="ml-1 text-xs text-slate-500">{detail}</span>}
      </span>
    </li>
  );
}

/** Edit which template (if any) is attached to a follow-up. */
function SetupForm({ task }: { task: Task }) {
  const router = useRouter();
  const close = useModalClose();
  const [templates, setTemplates] = useState<{ id: string; name: string }[] | null>(null);
  const [enabled, setEnabled] = useState(task.auto_email ?? false);
  const [templateId, setTemplateId] = useState(task.email_template_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .from("email_templates")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTemplates(data ?? []));
  }, []);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await setTaskEmail(task.id, enabled, enabled ? templateId || null : templateId || null);
        setBusy(false);
        if (res.ok) {
          toast.success(enabled ? "Email automation on" : "Email automation off");
          close?.();
          router.refresh();
        } else setError(res.error);
      }}
    >
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Email {task.contacts?.name ?? "the contact"} automatically when this follow-up is due
      </label>
      <div>
        <label className="label" htmlFor="auto-template">Template</label>
        <select
          id="auto-template"
          className="input"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          disabled={templates === null}
        >
          <option value="">{templates === null ? "Loading…" : "Choose a template…"}</option>
          {templates?.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      {!task.contacts?.email && enabled && (
        <p className="text-sm text-amber-700">This contact has no email address yet, so nothing can be sent.</p>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={() => close?.()}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
        </button>
      </div>
    </form>
  );
}

function RunPanel({
  phase,
  progress,
  error,
  onRetry,
  onClose,
}: {
  phase: Phase;
  progress: EmailProgress | null;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const sent = progress?.emailStatus === "sent";
  const completed = progress?.taskStatus === "completed";
  const logged = !!progress?.activityLogged;
  const failed = phase === "failed";

  return (
    <div className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 p-3" aria-live="polite">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Automation run</p>
      <ul className="space-y-1.5">
        <Step
          state={failed && !sent ? "bad" : sent ? "ok" : "run"}
          label={sent ? "Email sent" : failed ? "Email not sent" : "Processing…"}
          detail={
            sent && progress?.to
              ? progress.testMode
                ? `to ${progress.to} (test mode, intended for ${progress.intended})`
                : `to ${progress.to}`
              : undefined
          }
        />
        <Step state={completed ? "ok" : "wait"} label="Task completed" />
        <Step state={logged ? "ok" : "wait"} label="Activity logged" />
      </ul>
      {failed && error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        {failed && (
          <button type="button" className="btn-secondary !py-1 text-xs" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </button>
        )}
        <button type="button" className="btn-secondary !py-1 text-xs" onClick={onClose} disabled={phase === "processing"}>
          {phase === "done" ? "Done" : "Close"}
        </button>
      </div>
    </div>
  );
}

/** Per-task automation controls: what is attached, current status, edit, and "Run automation now". */
export function EmailAutomation({ task }: { task: Task }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<EmailProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Runs the real automation, then follows what actually happens in the database. */
  async function start() {
    setOpen(true);
    setPhase("processing");
    setRunError(null);
    setProgress(null);

    const res = await runAutomationNow(task.id);
    if (!alive.current) return;
    if (!res.ok) {
      setRunError(res.error);
      setPhase("failed");
      return;
    }

    const started = Date.now();
    while (alive.current) {
      const p = await getEmailProgress(task.id);
      if (!alive.current) return;
      setProgress(p);
      if (!p.ok) {
        setRunError(p.error ?? "Could not read the status.");
        setPhase("failed");
        return;
      }
      if (p.emailStatus === "sent") {
        setPhase("done");
        toast.success("Email sent");
        router.refresh();
        return;
      }
      if (p.emailStatus === "failed") {
        setRunError(p.emailError ?? "The email could not be sent.");
        setPhase("failed");
        router.refresh();
        return;
      }
      if (Date.now() - started > MAX_WAIT_MS) {
        setRunError("Still waiting for the email provider. Check the Email page for the final result.");
        setPhase("failed");
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const status = task.email_status ?? "none";
  const pending = task.status === "pending";
  const on = !!task.auto_email;
  const templateName = task.email_templates?.name;
  const hasEmail = !!task.contacts?.email;

  // Nothing to show for plain follow-ups with automation off and no history.
  if (!on && status === "none") {
    return pending ? (
      <div className="mt-1">
        <Modal
          title="Email automation"
          triggerLabel="Add email automation"
          triggerClassName="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600"
          triggerIcon={<Mail className="h-3 w-3" />}
        >
          <SetupForm task={task} />
        </Modal>
      </div>
    ) : null;
  }

  const badge =
    status === "sent" ? (
      <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">Email sent</Badge>
    ) : status === "queued" ? (
      <Badge className="bg-indigo-50 text-indigo-700 ring-indigo-200">Sending…</Badge>
    ) : status === "failed" ? (
      <Badge className="bg-red-50 text-red-700 ring-red-200">Email failed</Badge>
    ) : pending && on ? (
      <Badge className="bg-slate-100 text-slate-600 ring-slate-200">Scheduled</Badge>
    ) : null;

  return (
    <div className="mt-1.5 flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
      <span className="inline-flex items-center gap-1">
        <Mail className="h-3 w-3" aria-hidden />
        Automation: <strong className={on ? "text-emerald-700" : "text-slate-500"}>{on ? "ON" : "OFF"}</strong>
        {on && (
          <>
            {" · Template: "}
            {templateName ? <strong className="text-slate-700">{templateName}</strong> : <em className="text-amber-700">none selected</em>}
          </>
        )}
      </span>
      {badge}
      {status === "failed" && task.email_error && (
        <span className="text-red-600" title={task.email_error}>{task.email_error.slice(0, 90)}</span>
      )}
      {pending && (
        <>
          <Modal
            title="Email automation"
            triggerLabel="Edit"
            triggerClassName="inline-flex items-center gap-1 text-slate-400 hover:text-indigo-600"
            triggerIcon={<Pencil className="h-3 w-3" />}
          >
            <SetupForm task={task} />
          </Modal>
          {on && templateName && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              disabled={phase === "processing" || !hasEmail || status === "queued"}
              title={hasEmail ? "Send the email now, exactly as the scheduler would" : "This contact has no email address"}
              onClick={start}
            >
              <Play className="h-3 w-3" /> Run automation now
            </button>
          )}
          {on && !hasEmail && <span className="text-amber-700">Contact has no email address</span>}
        </>
      )}
      {open && (
        <RunPanel phase={phase} progress={progress} error={runError} onRetry={start} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
