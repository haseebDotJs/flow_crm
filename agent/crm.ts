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

  return {
    ok: true as const,
    changed: true,
    opportunity: { ...data, previous_stage: previous, contact: contactName },
  };
}

// -------------------------------------------------------- create_follow_up
export const createFollowUpInput = z.object({
  contact_id: uuid,
  opportunity_id: optionalUuid,
  title: z.string().trim().min(1).max(200),
  due_at: z.string().trim().min(1).max(100),
});

const PAST_GRACE_MS = 60_000;

export async function createFollowUp(ctx: CrmContext, input: unknown) {
  const parsed = createFollowUpInput.safeParse(input);
  if (!parsed.success) {
    return invalid(parsed.error, "due_at is required: use a local ISO date-time such as 2026-10-02T09:00:00.");
  }
  const { contact_id, opportunity_id, title, due_at } = parsed.data;

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
