/**
 * Stores the email provider key in Supabase's encrypted Vault (once).
 * Usage: npm run email:setup
 *
 * Reads RESEND_API_KEY (and optionally EMAIL_FROM) from .env.local and sends them to the
 * service-role-only function set_email_secret(). The key is never printed, and the web app
 * and agent never see it: only the database function that sends emails can read it.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!url || !secret) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  if (!key) throw new Error("Missing RESEND_API_KEY in .env.local");

  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

  const stored = await admin.rpc("set_email_secret", { p_name: "resend_api_key", p_value: key });
  if (stored.error) throw new Error(`Could not store the key: ${stored.error.message}`);
  console.log(`Stored RESEND_API_KEY in Vault (${key.length} characters, not shown).`);

  if (from) {
    const f = await admin.rpc("set_email_secret", { p_name: "resend_from", p_value: from });
    if (f.error) throw new Error(`Could not store EMAIL_FROM: ${f.error.message}`);
    console.log(`Stored sender address: ${from}`);
  } else {
    console.log("No EMAIL_FROM set: using the Resend sandbox sender (FlowCRM <onboarding@resend.dev>).");
  }

  const status = await admin.rpc("automation_status");
  console.log("Status:", JSON.stringify(status.data));
  process.exit(0);
}

main().catch((e) => {
  console.error("Setup failed:", e.message ?? e);
  process.exit(1);
});
