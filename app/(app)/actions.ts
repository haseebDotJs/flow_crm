"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { STAGES, TASK_STATUSES } from "@/types";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: optionalText.refine((v) => v === null || z.string().email().safeParse(v).success, "Invalid email"),
  phone: optionalText,
  company: optionalText,
  notes: optionalText,
});

const opportunitySchema = z.object({
  contact_id: z.string().uuid("Choose a contact"),
  title: z.string().trim().min(1, "Title is required").max(200),
  value: z.coerce.number().min(0, "Value must be 0 or more").max(1e12),
  stage: z.enum(STAGES).default("new"),
  notes: optionalText,
});

const taskSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: optionalText,
  contact_id: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  opportunity_id: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  due_at: z
    .string()
    .min(1, "Due date is required")
    .transform((v, ctx) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: "Invalid due date" });
        return z.NEVER;
      }
      return d.toISOString();
    }),
});

function fail(error: string): ActionResult {
  return { ok: false, error };
}

function fromForm(input: FormData | Record<string, unknown>) {
  const raw = input instanceof FormData ? Object.fromEntries(input) : input;
  // Treat empty selects/inputs as null.
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === "" ? null : v]));
}

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

function revalidateAll() {
  ["/dashboard", "/contacts", "/pipeline", "/tasks", "/activity"].forEach((p) => revalidatePath(p));
  revalidatePath("/contacts/[id]", "page");
  revalidatePath("/opportunities/[id]", "page");
}

// ---------------------------------------------------------------- contacts
export async function saveContact(
  input: FormData | Record<string, unknown>,
  id?: string,
): Promise<ActionResult> {
  const parsed = contactSchema.safeParse(fromForm(input));
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in");

  const query = id
    ? supabase.from("contacts").update(parsed.data).eq("id", id).select("id").single()
    : supabase.from("contacts").insert({ ...parsed.data, user_id: user.id }).select("id").single();
  const { data, error } = await query;
  if (error) return fail(error.message);
  revalidateAll();
  return { ok: true, id: data.id };
}

// ----------------------------------------------------------- opportunities
export async function createOpportunity(
  input: FormData | Record<string, unknown>,
): Promise<ActionResult> {
  const parsed = opportunitySchema.safeParse(fromForm(input));
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in");

  const { data, error } = await supabase
    .from("opportunities")
    .insert({ ...parsed.data, user_id: user.id })
    .select("id")
    .single();
  if (error) return fail(error.message);
  revalidateAll();
  return { ok: true, id: data.id };
}

export async function updateOpportunityStage(id: string, stage: string): Promise<ActionResult> {
  const parsed = z.enum(STAGES).safeParse(stage);
  if (!parsed.success) return fail("Invalid stage");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in");

  const { data, error } = await supabase
    .from("opportunities")
    .update({ stage: parsed.data })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return fail(error.message);
  if (!data) return fail("Opportunity not found");
  revalidateAll();
  return { ok: true, id: data.id };
}

// ------------------------------------------------------------------- tasks
export async function createTask(input: FormData | Record<string, unknown>): Promise<ActionResult> {
  const parsed = taskSchema.safeParse(fromForm(input));
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in");

  const { data, error } = await supabase
    .from("tasks")
    .insert({ ...parsed.data, user_id: user.id })
    .select("id")
    .single();
  if (error) return fail(error.message);
  revalidateAll();
  return { ok: true, id: data.id };
}

export async function setTaskStatus(id: string, status: string): Promise<ActionResult> {
  const parsed = z.enum(TASK_STATUSES).safeParse(status);
  if (!parsed.success) return fail("Invalid status");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in");

  const { data, error } = await supabase
    .from("tasks")
    .update({ status: parsed.data })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return fail(error.message);
  if (!data) return fail("Task not found");
  revalidateAll();
  return { ok: true, id: data.id };
}
