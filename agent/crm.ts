/**
 * Structured CRM operations used by the Voice AI.
 *
 * Every function:
 *  - takes a Supabase client that is authenticated AS THE USER (RLS enforced by Postgres),
 *  - additionally scopes each query by `user_id` (defence in depth),
 *  - validates its own input and never trusts the LLM.
 * There is intentionally no generic query / SQL entry point.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatSpoken, parseDueAt } from "./datetime";

export const STAGES = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

const uuid = z.string().trim().uuid();
/** Models sometimes send "" or "null" for an omitted optional id; treat those as absent. */
const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && ["", "null", "none", "undefined"].includes(v.trim().toLowerCase()) ? undefined : v),
  uuid.nullish(),
);

export interface CrmContext {
  db: SupabaseClient;
  userId: string;
  timeZone: string;
  now?: () => Date;
}

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message });

/** Tell the model exactly which fields were wrong so it can correct the call itself. */
const invalid = (error: z.ZodError, hint = ""): Result<never> =>
  fail(
    "invalid_input",
    `Invalid arguments: ${error.issues.map((i) => `${i.path.join(".") || "input"} (${i.message})`).join("; ")}. ${hint}`.trim(),
  );

/** Remove characters that have meaning in PostgREST filters / LIKE patterns. */
function clean(term: string) {
  return term.replace(/[%_,()*\\"']/g, " ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------ find_contact
export const findContactInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).nullish(),
  company: z.string().trim().max(200).nullish(),
});

export async function findContact(ctx: CrmContext, input: unknown) {
  const parsed = findContactInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, "Provide the contact's name.");
  const { name, email, company } = parsed.data;

  const pattern = clean(name).split(" ").join("%");
  if (!pattern) return fail("invalid_input", "A contact name is required.");

  let q = ctx.db
    .from("contacts")
    .select("id, name, company, email")
    .eq("user_id", ctx.userId)
    .ilike("name", `%${pattern}%`)
    .order("name")
    .limit(6);
  if (email && clean(email)) q = q.ilike("email", `%${clean(email)}%`);
  if (company && clean(company)) q = q.ilike("company", `%${clean(company)}%`);

  const { data, error } = await q;
  if (error) return fail("db_error", "I couldn't search contacts right now.");
  const rows = data ?? [];

  if (rows.length === 0) {
    return { ok: true as const, status: "not_found" as const, contacts: [], message: `No contact matches "${name}". Offer to create a new contact; do not invent one.` };
  }
  // Prefer a single exact name match over looser partial matches.
  const exact = rows.filter((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  const chosen = exact.length === 1 ? exact : rows;
  if (chosen.length === 1) {
    return { ok: true as const, status: "found" as const, contacts: chosen };
  }
  return {
    ok: true as const,
    status: "multiple" as const,
    contacts: chosen,
    message: "Multiple contacts match. Ask the user which one they mean (mention company or email). Do not guess.",
  };
}

// ------------------------------------------------------ find_opportunities
export const findOpportunitiesInput = z.object({
  contact_id: uuid,
  stage: z.enum(STAGES).nullish(),
});

export async function findOpportunities(ctx: CrmContext, input: unknown) {
  const parsed = findOpportunitiesInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, "Use the contact id returned by find_contact.");
  const { contact_id, stage } = parsed.data;

  const contact = await ctx.db
    .from("contacts")
    .select("id, name")
    .eq("id", contact_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (contact.error) return fail("db_error", "I couldn't look up that contact right now.");
  if (!contact.data) return fail("not_found", "That contact doesn't exist.");

  let q = ctx.db
    .from("opportunities")
    .select("id, title, value, stage")
    .eq("user_id", ctx.userId)
    .eq("contact_id", contact_id)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (stage) q = q.eq("stage", stage);

  const { data, error } = await q;
  if (error) return fail("db_error", "I couldn't load opportunities right now.");
  const opportunities = data ?? [];

  const status = opportunities.length === 0 ? "none" : opportunities.length === 1 ? "single" : "multiple";
  return {
    ok: true as const,
    status,
    contact: contact.data,
    opportunities,
    ...(status === "multiple" && {
      message: "The contact has multiple opportunities. Ask which one, unless the user already named it.",
    }),
  };
}

// ------------------------------------------------- update_opportunity_stage
export const updateStageInput = z.object({
  opportunity_id: uuid,
  stage: z.enum(STAGES),
});

export async function updateOpportunityStage(ctx: CrmContext, input: unknown) {
  const parsed = updateStageInput.safeParse(input);
  if (!parsed.success) {
    return invalid(parsed.error, `Use an id from find_opportunities and a stage from: ${STAGES.join(", ")}.`);
  }
  const { opportunity_id, stage } = parsed.data;

  const current = await ctx.db
    .from("opportunities")
    .select("id, title, stage, contacts(name)")
    .eq("id", opportunity_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (current.error) return fail("db_error", "I couldn't load that opportunity right now.");
  if (!current.data) return fail("not_found", "That opportunity doesn't exist or isn't yours.");

  const contactName = (current.data.contacts as unknown as { name: string } | null)?.name ?? null;
  const previous = current.data.stage as Stage;
  if (previous === stage) {
    return {
      ok: true as const,
      changed: false,
      opportunity: { id: opportunity_id, title: current.data.title, stage, previous_stage: previous, contact: contactName },
      message: `Already in ${stage}; nothing changed.`,
    };
  }

  const { data, error } = await ctx.db
    .from("opportunities")
    .update({ stage })
    .eq("id", opportunity_id)
    .eq("user_id", ctx.userId)
    .select("id, title, stage")
    .maybeSingle();
  if (error) return fail("db_error", "I couldn't update the opportunity.");
  if (!data) return fail("not_found", "That opportunity doesn't exist or isn't yours.");

  // New -> Qualified triggers an automatic follow-up in the database; report it so the assistant
  // can say so accurately (and so it never offers to "schedule one" that already exists).
  let defaultFollowUp: { in: string } | undefined;
  if (previous === "new" && stage === "qualified") {
    const auto = await ctx.db
      .from("tasks")
      .select("id, due_at")
      .eq("user_id", ctx.userId)
      .eq("opportunity_id", opportunity_id)
      .eq("source", "automation")
      .eq("status", "pending")
      .maybeSingle();
    // The interval differs in demo mode (30 seconds instead of 2 days), so report the real one.
    if (auto.data) {
      defaultFollowUp = { in: describeInterval(new Date(auto.data.due_at).getTime() - (ctx.now ?? (() => new Date()))().getTime()) };
    }
  }

  return {
    ok: true as const,
    changed: true,
    opportunity: { ...data, previous_stage: previous, contact: contactName },
    ...(defaultFollowUp && {
      default_follow_up: defaultFollowUp,
      note:
        `A default follow-up was created automatically, due in ${defaultFollowUp.in}. If the user asked for their own ` +
        "follow-up, do not mention it (create_follow_up will replace it). If the user asked for none, tell them it " +
        `was added 'in ${defaultFollowUp.in}' and do not offer to create one.`,
    }),
  };
}

/** "about 30 seconds", "10 minutes", "5 hours", "two days": how far away a due time is, for speech. */
export function describeInterval(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 90) return `about ${Math.max(10, Math.round(secs / 10) * 10)} seconds`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 2 ? "two days" : `${days} days`;
}

// ------------------------------------------------------------- follow-ups
/**
 * Where the time came from. The assistant must never invent a time:
 *  - user_stated:     the user said a time (or agreed to one the assistant suggested)
 *  - not_specified:   the user gave only a day -> the tool refuses and tells the model to ask
 */
const timeSource = z.enum(["user_stated", "not_specified"]);

export const createFollowUpInput = z.object({
  contact_id: uuid,
  opportunity_id: optionalUuid,
  title: z.string().trim().min(1).max(200),
  due_at: z.string().trim().min(1).max(100),
  time_source: timeSource.default("user_stated"),
  add_another: z.boolean().nullish(),
});

const PAST_GRACE_MS = 60_000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TIME_REQUIRED = fail(
  "time_required",
  "The user has not chosen a time. Nothing was created. Ask what time they want and suggest 9 AM as an option " +
    '(for example: "What time should I schedule it? I can do 9 AM if that works."). ' +
    "Then call again with the time they state (or 9 AM only if they agree), with time_source user_stated.",
);

/** A date with no time, or a model that says the time wasn't given, must not be turned into a task. */
function timeMissing(due_at: string, source: z.infer<typeof timeSource>) {
  return source === "not_specified" || DATE_ONLY_RE.test(due_at.trim());
}

type PendingTask = { id: string; title: string; due_at: string };

async function pendingForOpportunity(ctx: CrmContext, opportunityId: string): Promise<PendingTask[]> {
  const { data } = await ctx.db
    .from("tasks")
    .select("id, title, due_at")
    .eq("user_id", ctx.userId)
    .eq("opportunity_id", opportunityId)
    .eq("status", "pending")
    .order("due_at", { ascending: true });
  return data ?? [];
}

const describeTask = (t: PendingTask, tz: string) => ({
  id: t.id,
  title: t.title,
  due_at: t.due_at,
  spoken_due: formatSpoken(new Date(t.due_at), tz),
});

export async function createFollowUp(ctx: CrmContext, input: unknown) {
  const parsed = createFollowUpInput.safeParse(input);
  if (!parsed.success) {
    return invalid(parsed.error, "due_at is required: use a local ISO date-time such as 2026-10-02T09:00:00.");
  }
  const { contact_id, opportunity_id, title, due_at, time_source, add_another } = parsed.data;

  if (timeMissing(due_at, time_source)) return TIME_REQUIRED;

  const due = parseDueAt(due_at, ctx.timeZone);
  if (!due) return fail("invalid_date", "due_at must be an ISO 8601 date-time like 2026-10-02T09:00:00. Resolve words like 'tomorrow' yourself.");
  const now = (ctx.now ?? (() => new Date()))();
  if (due.getTime() < now.getTime() - PAST_GRACE_MS) {
    return fail("date_in_past", "That date/time is in the past. Ask the user for a future time.");
  }

  const contact = await ctx.db
    .from("contacts")
    .select("id, name")
    .eq("id", contact_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (contact.error) return fail("db_error", "I couldn't look up that contact right now.");
  if (!contact.data) return fail("not_found", "That contact doesn't exist.");

  if (opportunity_id) {
    const opp = await ctx.db
      .from("opportunities")
      .select("id, contact_id")
      .eq("id", opportunity_id)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (opp.error) return fail("db_error", "I couldn't look up that opportunity right now.");
    if (!opp.data) return fail("not_found", "That opportunity doesn't exist.");
    if (opp.data.contact_id !== contact_id) {
      return fail("mismatch", "That opportunity does not belong to that contact.");
    }

    // Idempotency: a repeated tool call must not create a second identical task.
    const existing = await findDuplicate(ctx, opportunity_id, title, due);
    if (existing) return taskResult(existing, ctx.timeZone, contact.data.name, true);

    // Moving a deal to Qualified auto-creates a generic follow-up (source = 'automation').
    // The user's explicit request takes over that task rather than adding a second one.
    const adopted = await ctx.db
      .from("tasks")
      .update({ title, due_at: due.toISOString(), source: "manual" })
      .eq("user_id", ctx.userId)
      .eq("opportunity_id", opportunity_id)
      .eq("source", "automation")
      .eq("status", "pending")
      .select("id, title, due_at")
      .maybeSingle();
    if (adopted.data) return { ...taskResult(adopted.data, ctx.timeZone, contact.data.name, false), adopted_automation: true };

    // Don't silently stack a second follow-up on the same deal: make the user choose.
    if (!add_another) {
      const pending = await pendingForOpportunity(ctx, opportunity_id);
      if (pending.length > 0) {
        return {
          ok: false as const,
          code: "follow_up_exists",
          existing: pending.map((t) => describeTask(t, ctx.timeZone)),
          message:
            "This deal already has a pending follow-up (see existing). Nothing was created. Ask whether to " +
            "reschedule the existing one (use reschedule_follow_up) or add another one (call create_follow_up again " +
            "with add_another true). If the user said to change/move it, reschedule.",
        };
      }
    }
  }

  const inserted = await ctx.db
    .from("tasks")
    .insert({
      user_id: ctx.userId,
      contact_id,
      opportunity_id: opportunity_id ?? null,
      title,
      due_at: due.toISOString(),
    })
    .select("id, title, due_at")
    .single();

  if (inserted.error) {
    // Unique index (user, opportunity, title, due_at) caught a concurrent duplicate.
    if (inserted.error.code === "23505" && opportunity_id) {
      const existing = await findDuplicate(ctx, opportunity_id, title, due);
      if (existing) return taskResult(existing, ctx.timeZone, contact.data.name, true);
    }
    return fail("db_error", "I couldn't create the follow-up.");
  }
  return taskResult(inserted.data, ctx.timeZone, contact.data.name, false);
}

// -------------------------------------------------------- find_follow_ups
export const findFollowUpsInput = z
  .object({ contact_id: optionalUuid, opportunity_id: optionalUuid })
  .refine((v) => v.contact_id || v.opportunity_id, { message: "contact_id or opportunity_id is required" });

export async function findFollowUps(ctx: CrmContext, input: unknown) {
  const parsed = findFollowUpsInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, "Pass the contact_id and/or opportunity_id from earlier tool results.");
  const { contact_id, opportunity_id } = parsed.data;

  let q = ctx.db
    .from("tasks")
    .select("id, title, due_at, contacts(name), opportunities(title)")
    .eq("user_id", ctx.userId)
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(10);
  if (contact_id) q = q.eq("contact_id", contact_id);
  if (opportunity_id) q = q.eq("opportunity_id", opportunity_id);

  const { data, error } = await q;
  if (error) return fail("db_error", "I couldn't load follow-ups right now.");
  const rows = (data ?? []) as unknown as (PendingTask & {
    contacts: { name: string } | null;
    opportunities: { title: string } | null;
  })[];

  return {
    ok: true as const,
    status: rows.length === 0 ? ("none" as const) : rows.length === 1 ? ("single" as const) : ("multiple" as const),
    follow_ups: rows.map((t) => ({
      ...describeTask(t, ctx.timeZone),
      contact: t.contacts?.name ?? null,
      opportunity: t.opportunities?.title ?? null,
    })),
    ...(rows.length > 1 && { message: "Several pending follow-ups. Ask which one, unless the user already made it clear." }),
  };
}

// ---------------------------------------------------- reschedule_follow_up
export const rescheduleFollowUpInput = z.object({
  task_id: uuid,
  due_at: z.string().trim().min(1).max(100),
  time_source: timeSource.default("user_stated"),
});

export async function rescheduleFollowUp(ctx: CrmContext, input: unknown) {
  const parsed = rescheduleFollowUpInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, "Use a task id from find_follow_ups and a local ISO date-time.");
  const { task_id, due_at, time_source } = parsed.data;

  if (timeMissing(due_at, time_source)) return TIME_REQUIRED;
  const due = parseDueAt(due_at, ctx.timeZone);
  if (!due) return fail("invalid_date", "due_at must be an ISO 8601 date-time like 2026-10-02T21:00:00.");
  const now = (ctx.now ?? (() => new Date()))();
  if (due.getTime() < now.getTime() - PAST_GRACE_MS) {
    return fail("date_in_past", "That date/time is in the past. Ask the user for a future time.");
  }

  const current = await ctx.db
    .from("tasks")
    .select("id, title, due_at, status")
    .eq("id", task_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (current.error) return fail("db_error", "I couldn't load that follow-up right now.");
  if (!current.data) return fail("not_found", "That follow-up doesn't exist.");
  if (current.data.status !== "pending") {
    return fail("not_pending", `That follow-up is already ${current.data.status}, so it can't be rescheduled.`);
  }

  const { data, error } = await ctx.db
    .from("tasks")
    .update({ due_at: due.toISOString() })
    .eq("id", task_id)
    .eq("user_id", ctx.userId)
    .eq("status", "pending")
    .select("id, title, due_at")
    .maybeSingle();
  if (error) return fail("db_error", "I couldn't reschedule the follow-up.");
  if (!data) return fail("not_found", "That follow-up is no longer pending.");

  return {
    ok: true as const,
    task: { id: data.id, title: data.title, due_at: data.due_at },
    previous_spoken_due: formatSpoken(new Date(current.data.due_at), ctx.timeZone),
    spoken_due: formatSpoken(new Date(data.due_at), ctx.timeZone),
  };
}

// ------------------------------------------------------- cancel_follow_up
export const cancelFollowUpInput = z.object({ task_id: uuid });

/** "Remove/delete a follow-up" by voice = cancel it. Nothing is hard-deleted; it stays in the activity log. */
export async function cancelFollowUp(ctx: CrmContext, input: unknown) {
  const parsed = cancelFollowUpInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, "Use a task id from find_follow_ups.");
  const { task_id } = parsed.data;

  const current = await ctx.db
    .from("tasks")
    .select("id, title, due_at, status")
    .eq("id", task_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (current.error) return fail("db_error", "I couldn't load that follow-up right now.");
  if (!current.data) return fail("not_found", "That follow-up doesn't exist.");
  if (current.data.status !== "pending") {
    return fail("not_pending", `That follow-up is already ${current.data.status}.`);
  }

  const { data, error } = await ctx.db
    .from("tasks")
    .update({ status: "cancelled" })
    .eq("id", task_id)
    .eq("user_id", ctx.userId)
    .eq("status", "pending")
    .select("id, title, due_at")
    .maybeSingle();
  if (error) return fail("db_error", "I couldn't cancel the follow-up.");
  if (!data) return fail("not_found", "That follow-up is no longer pending.");

  return {
    ok: true as const,
    task: { id: data.id, title: data.title },
    cancelled_spoken_due: formatSpoken(new Date(data.due_at), ctx.timeZone),
  };
}

async function findDuplicate(ctx: CrmContext, opportunityId: string, title: string, due: Date) {
  const { data } = await ctx.db
    .from("tasks")
    .select("id, title, due_at")
    .eq("user_id", ctx.userId)
    .eq("opportunity_id", opportunityId)
    .eq("title", title)
    .eq("due_at", due.toISOString())
    .eq("status", "pending")
    .maybeSingle();
  return data;
}

function taskResult(
  task: { id: string; title: string; due_at: string },
  tz: string,
  contactName: string,
  duplicate: boolean,
) {
  return {
    ok: true as const,
    duplicate,
    task: { id: task.id, title: task.title, due_at: task.due_at, contact: contactName },
    spoken_due: formatSpoken(new Date(task.due_at), tz),
    ...(duplicate && { message: "An identical follow-up already existed, so none was added." }),
  };
}
