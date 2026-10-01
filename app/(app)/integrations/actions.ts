"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkWebhookUrl, sendTestEvent } from "@/lib/webhooks";

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

const refresh = () => revalidatePath("/integrations");

// ------------------------------------------------------------ outbound webhook
export async function saveWebhook(input: { url: string; enabled: boolean }): Promise<Result> {
  const parsed = z.object({ url: z.string().trim().min(1).max(2000), enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return fail("Enter a webhook URL.");
  const problem = await checkWebhookUrl(parsed.data.url);
  if (problem) return fail(problem);

  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const { error } = await supabase
    .from("webhook_endpoints")
    .upsert({ user_id: user.id, url: parsed.data.url, enabled: parsed.data.enabled }, { onConflict: "user_id" });
  if (error) return fail("Could not save the webhook. Check the URL.");
  refresh();
  return { ok: true };
}

export async function setWebhookEnabled(enabled: boolean): Promise<Result> {
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { error } = await supabase.from("webhook_endpoints").update({ enabled }).eq("user_id", user.id);
  if (error) return fail("Could not update the webhook.");
  refresh();
  return { ok: true };
}

export async function regenerateWebhookSecret(): Promise<Result> {
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { error } = await supabase
    .from("webhook_endpoints")
    .update({ secret: randomBytes(24).toString("hex") })
    .eq("user_id", user.id);
  if (error) return fail("Could not regenerate the secret.");
  refresh();
  return { ok: true };
}

export async function deleteWebhook(): Promise<Result> {
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { error } = await supabase.from("webhook_endpoints").delete().eq("user_id", user.id);
  if (error) return fail("Could not remove the webhook.");
  refresh();
  return { ok: true };
}

export async function sendTestWebhook(): Promise<Result<{ status: number }>> {
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { data: ep } = await supabase.from("webhook_endpoints").select("url, secret").eq("user_id", user.id).maybeSingle();
  if (!ep) return fail("Save a webhook URL first.");
  const problem = await checkWebhookUrl(ep.url);
  if (problem) return fail(problem);
  try {
    const { status, ok } = await sendTestEvent(ep.url, ep.secret);
    return ok ? { ok: true, status } : fail(`Your endpoint responded with HTTP ${status}.`);
  } catch {
    return fail("Could not reach your endpoint (timeout or connection error).");
  }
}

// -------------------------------------------------------------------- API keys
export async function createApiKey(name: string): Promise<Result<{ key: string }>> {
  const parsed = z.string().trim().min(1, "Give the key a name").max(100).safeParse(name);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");

  const key = `fcrm_${randomBytes(32).toString("base64url")}`;
  const { error } = await supabase.from("api_keys").insert({
    user_id: user.id,
    name: parsed.data,
    key_prefix: key.slice(0, 10),
    key_hash: createHash("sha256").update(key).digest("hex"),
  });
  if (error) return fail("Could not create the key.");
  refresh();
  // The plaintext key is returned once here and never stored.
  return { ok: true, key };
}

export async function revokeApiKey(id: string): Promise<Result> {
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid key.");
  const { supabase, user } = await requireUser();
  if (!user) return fail("Not signed in.");
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null);
  if (error) return fail("Could not revoke the key.");
  refresh();
  return { ok: true };
}
