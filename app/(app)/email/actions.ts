"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

const refresh = () => {
  for (const p of ["/email", "/tasks", "/dashboard", "/activity"]) revalidatePath(p);
  revalidatePath("/contacts/[id]", "page");
  revalidatePath("/opportunities/[id]", "page");
};

// ----------------------------------------------------------------- templates
const templateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name").max(100),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  body: z.string().trim().min(1, "Body is required").max(5000),
});

export async function saveTemplate(
  input: { name: string; subject: string; body: string },
  id?: string,
): Promise<{ ok: true } | Fail> {
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const { error } = id
    ? await supabase.from("email_templates").update(parsed.data).eq("id", id)
    : await supabase.from("email_templates").insert({ ...parsed.data, user_id: user.id });
  if (error) {
    return fail(error.code === "23505" ? "You already have a template with that name." : "Could not save the template.");
  }
  refresh();
  return { ok: true };
}

export async function deleteTemplate(id: string): Promise<{ ok: true } | Fail> {
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid template.");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { error } = await supabase.from("email_templates").delete().eq("id", id);
  if (error) return fail("Could not delete the template.");
  refresh();
  return { ok: true };
}

// ------------------------------------------------------------------ settings
export async function saveEmailSettings(input: {
  testMode: boolean;
  testRecipient: string;
}): Promise<{ ok: true } | Fail> {
  const parsed = z
    .object({
      testMode: z.boolean(),
      testRecipient: z.string().trim().max(200).email("Enter a valid email address").or(z.literal("")),
    })
    .safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const { error } = await supabase
    .from("profiles")
    .update({ email_test_mode: parsed.data.testMode, email_test_recipient: parsed.data.testRecipient || null })
    .eq("id", user.id);
  if (error) return fail("Could not save the settings.");
  refresh();
  return { ok: true };
}

// ------------------------------------------------------ follow-up automation
export async function setTaskEmail(
  taskId: string,
  enabled: boolean,
  templateId: string | null,
): Promise<{ ok: true } | Fail> {
  if (!z.string().uuid().safeParse(taskId).success) return fail("Invalid follow-up.");
  if (templateId !== null && !z.string().uuid().safeParse(templateId).success) return fail("Invalid template.");
  if (enabled && !templateId) return fail("Choose a template to turn the automation on.");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const { data, error } = await supabase
    .from("tasks")
    .update({ auto_email: enabled, email_template_id: templateId })
    .eq("id", taskId)
    .select("id")
    .maybeSingle();
  if (error) return fail("Could not update the automation.");
  if (!data) return fail("Follow-up not found.");
  refresh();
  return { ok: true };
}

export type RunResult =
  | { ok: true; to: string; testMode: boolean }
  | { ok: false; error: string };

/** "Run automation now": executes the real send function (same one the scheduler uses). */
export async function runAutomationNow(taskId: string): Promise<RunResult> {
  if (!z.string().uuid().safeParse(taskId).success) return fail("Invalid follow-up.");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const { data, error } = await supabase.rpc("run_follow_up_automation", { p_task_id: taskId });
  if (error || !data) return fail("Could not start the automation.");
  if (!data.ok) return fail(data.message ?? "Could not start the automation.");
  return { ok: true, to: data.to, testMode: data.test_mode };
}

export interface EmailProgress {
  ok: boolean;
  error?: string;
  taskStatus?: string;
  emailStatus?: "none" | "queued" | "sent" | "failed";
  emailError?: string | null;
  to?: string | null;
  intended?: string | null;
  subject?: string | null;
  testMode?: boolean | null;
  activityLogged?: boolean;
}

/** What has really happened so far (reads the database; nothing is simulated). */
export async function getEmailProgress(taskId: string): Promise<EmailProgress> {
  if (!z.string().uuid().safeParse(taskId).success) return { ok: false, error: "Invalid follow-up." };
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data, error } = await supabase.rpc("refresh_email_status", { p_task_id: taskId });
  if (error || !data?.ok) return { ok: false, error: data?.message ?? "Could not read the status." };
  const out: EmailProgress = {
    ok: true,
    taskStatus: data.task_status,
    emailStatus: data.email_status,
    emailError: data.email_error,
    to: data.to,
    intended: data.intended,
    subject: data.subject,
    testMode: data.test_mode,
    activityLogged: data.activity_logged,
  };
  if (data.email_status !== "queued") refresh();
  return out;
}
