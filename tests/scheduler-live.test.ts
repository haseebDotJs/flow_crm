/**
 * LIVE scheduler check (about 1 minute): proves the real pg_cron job picks up a due follow-up
 * when demo mode is on, and not before it is due.
 *
 * It uses a throwaway user whose recipient is NOT the Resend account address, so Resend's
 * sandbox rejects the request: the scheduler runs its full real code path but no email is
 * delivered to anyone. Restores the previous demo-mode setting.
 * Usage: npm run test:scheduler   (not part of `npm test`: slow, and it calls the real provider)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, opts);

let user: SupabaseClient;
let userId = "";
let original = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  original = Boolean(((await admin.rpc("automation_status")).data as { demo_mode: boolean }).demo_mode);
  const email = `scheduler-live-${Date.now()}@flowcrm.test`;
  const password = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  userId = created.data.user!.id;
  user = createClient(url, publishable, opts);
  await user.auth.signInWithPassword({ email, password });
});

after(async () => {
  await admin.rpc("set_demo_mode", { p_on: original });
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe("scheduler runs on time in demo mode", () => {
  it("sends the Qualified follow-up about 30-60 seconds after the stage change, not before", async () => {
    await admin.rpc("set_demo_mode", { p_on: true });

    const contact = await user.from("contacts").insert({ user_id: userId, name: "Live Test", email: "live@example.com", company: "Livenco" }).select("id").single();
    const opp = await user
      .from("opportunities")
      .insert({ user_id: userId, contact_id: contact.data!.id, title: "Live deal", value: 1000, stage: "new" })
      .select("id")
      .single();

    const t0 = Date.now();
    await user.from("opportunities").update({ stage: "qualified" }).eq("id", opp.data!.id);
    const { data: task } = await user
      .from("tasks")
      .select("id, due_at, auto_email, source")
      .eq("opportunity_id", opp.data!.id)
      .single();
    assert.equal(task?.auto_email, true);
    assert.equal(task?.source, "automation");
    const dueIn = new Date(task!.due_at).getTime() - t0;
    assert.ok(dueIn > 25_000 && dueIn < 40_000, `due in ${dueIn} ms`);

    // Wait for the scheduler to process it.
    let attemptedAt: number | null = null;
    let logRow: { status: string; error: string | null } | null = null;
    while (Date.now() - t0 < 100_000) {
      const { data } = await admin.from("email_log").select("status, error, created_at").eq("task_id", task!.id).limit(1);
      if (data && data.length > 0) {
        attemptedAt = new Date((data[0] as { created_at: string }).created_at).getTime();
        logRow = data[0];
        break;
      }
      await sleep(2000);
    }

    assert.ok(attemptedAt, "the scheduler never picked up the due follow-up");
    const afterMs = attemptedAt! - t0;
    console.log(`      scheduler attempted the send ${(afterMs / 1000).toFixed(1)} s after the stage change`);
    assert.ok(afterMs >= dueIn - 1500, `sent too early (${afterMs} ms, due at ${dueIn} ms)`);
    assert.ok(afterMs <= dueIn + 25_000, `scheduler was late (${afterMs} ms)`);

    // Let the call to the provider resolve, then check the real outcome.
    for (let i = 0; i < 15 && logRow?.status === "queued"; i++) {
      await sleep(2000);
      const { data } = await admin.from("email_log").select("status, error").eq("task_id", task!.id).limit(1);
      logRow = data![0];
    }
    assert.equal(logRow?.status, "failed", "rejected by the provider sandbox (recipient is not the account address)");
    assert.match(logRow!.error ?? "", /403/, "a real provider response came back");

    const { data: after } = await user.from("tasks").select("status, email_status").eq("id", task!.id).single();
    assert.equal(after?.status, "pending", "task stays pending when the email did not go out");
    assert.equal(after?.email_status, "failed");
  });
});
