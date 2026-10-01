/**
 * Copies DEMO from .env.local into the database (the database can't read .env files).
 *
 *   DEMO=true   follow-ups created by New -> Qualified are due in 30 seconds and the scheduler
 *               checks every 10 seconds, so the scheduled email automation is visible live.
 *   DEMO unset / false   normal behaviour (2 days, every minute).
 *
 * Runs automatically before `npm run dev` (predev) and from `npm run seed`; run it by hand with
 * `npm run demo:apply`. It never fails the caller: if anything is missing it just says so.
 * Uses the service-role key, like the seed script; the web app and agent never do.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const on = ["true", "1", "yes", "on"].includes((process.env.DEMO ?? "").trim().toLowerCase());

  if (!url || !secret) {
    console.log("[demo] skipped: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY not set in .env.local");
    return;
  }

  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.rpc("set_demo_mode", { p_on: on });
  if (error) {
    console.log(`[demo] could not apply DEMO (${error.message}). Have you run the latest migrations?`);
    return;
  }
  console.log(
    on
      ? `[demo] Demo mode ON: Qualified follow-ups are due in 30 s, scheduler runs every ${data.scheduler_schedule}.`
      : "[demo] Demo mode off (normal timing).",
  );
}

main()
  .catch((e) => console.log(`[demo] could not apply DEMO: ${e.message ?? e}`))
  .finally(() => process.exit(0));
