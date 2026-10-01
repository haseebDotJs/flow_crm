/**
 * Demo mode: Qualified follow-ups due in 30 s and a 10-second scheduler (vs 2 days / every minute).
 * Restores the previous demo-mode setting afterwards.
 *
 * Safety: while demo mode is on the real scheduler runs every 10 s with the real email key, so any
 * task created here is deleted within seconds, long before its 30-second due time.
 * Usage: npm run test:demo
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describeInterval, updateOpportunityStage, type CrmContext } from "../agent/crm";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

const admin = createClient(url, secret, opts);
let demo: SupabaseClient;
let ctx: CrmContext;
let oppId = "";
let original = false;

const setDemo = async (on: boolean) => {
  const { data, error } = await admin.rpc("set_demo_mode", { p_on: on });
  assert.equal(error, null, error?.message);
  return data as { demo_mode: boolean; scheduler_schedule: string };
};
const status = async () => (await admin.rpc("automation_status")).data as Record<string, unknown>;

/** Move John's deal New -> Qualified and return the automatic follow-up, deleting it right away. */
async function qualifyAndGrab() {
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  const before = Date.now();
  await demo.from("opportunities").update({ stage: "qualified" }).eq("id", oppId);
  const { data } = await demo.from("tasks").select("id, due_at, auto_email").eq("opportunity_id", oppId).single();
  await demo.from("tasks").delete().eq("id", data!.id); // never leave a due task for the real scheduler
  return { dueInMs: new Date(data!.due_at).getTime() - before, autoEmail: data!.auto_email };
}

before(async () => {
  original = Boolean((await status()).demo_mode);
  demo = createClient(url, publishable, opts);
  const { data, error } = await demo.auth.signInWithPassword({ email: "demo@flowcrm.test", password: "FlowCRM-demo-2026" });
  assert.equal(error, null);
  ctx = { db: demo, userId: data.user!.id, timeZone: "Europe/Warsaw" };
  const { data: opp } = await demo.from("opportunities").select("id").eq("title", "Acme Enterprise License").single();
  oppId = opp!.id;
});

after(async () => {
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await setDemo(original); // put back whatever DEMO was
});

describe("demo mode switch", () => {
  it("only the service role can change it", async () => {
    for (const fn of ["set_demo_mode", "is_demo_mode"] as const) {
      const { error } = await demo.rpc(fn, fn === "set_demo_mode" ? { p_on: true } : {});
      assert.ok(error, `${fn} must be denied to users`);
    }
    const direct = await demo.from("system_settings").select("*");
    assert.ok(direct.error || (direct.data?.length ?? 0) === 0, "settings table is not readable by users");
  });

  it("retimes the scheduler: every 10 seconds in demo mode, every minute otherwise", async () => {
    const on = await setDemo(true);
    assert.equal(on.scheduler_schedule, "10 seconds");
    const s1 = await status();
    assert.equal(s1.demo_mode, true);
    assert.equal(s1.scheduler_schedule, "10 seconds");
    assert.equal(s1.scheduler_active, true);

    const off = await setDemo(false);
    assert.equal(off.scheduler_schedule, "* * * * *");
    const s2 = await status();
    assert.equal(s2.demo_mode, false);
    assert.equal(s2.scheduler_schedule, "* * * * *");
    assert.equal(s2.scheduler_active, true, "the job stays active when switching");
  });

  it("users can read the status (flag + schedule) but it exposes no secrets", async () => {
    const { data } = await demo.rpc("automation_status");
    assert.deepEqual(Object.keys(data).sort(), ["demo_mode", "provider_configured", "scheduler_active", "scheduler_schedule"]);
  });
});

describe("Qualified follow-up timing", () => {
  it("demo OFF: due in 2 days", async () => {
    await setDemo(false);
    const { dueInMs, autoEmail } = await qualifyAndGrab();
    assert.equal(autoEmail, true);
    const days = dueInMs / 86_400_000;
    assert.ok(days > 1.99 && days < 2.01, `${days} days`);
  });

  it("demo ON: due in about 30 seconds", async () => {
    await setDemo(true);
    const { dueInMs, autoEmail } = await qualifyAndGrab();
    assert.equal(autoEmail, true, "still has the email automation attached");
    assert.ok(dueInMs > 25_000 && dueInMs < 40_000, `${dueInMs} ms`);
    await setDemo(false);
  });
});

describe("voice assistant wording", () => {
  it("describeInterval speaks naturally", () => {
    assert.equal(describeInterval(30_000), "about 30 seconds");
    assert.equal(describeInterval(28_000), "about 30 seconds");
    assert.equal(describeInterval(5 * 60_000), "5 minutes");
    assert.equal(describeInterval(3 * 3_600_000), "3 hours");
    assert.equal(describeInterval(2 * 86_400_000), "two days");
    assert.equal(describeInterval(3 * 86_400_000), "3 days");
  });

  it("the stage tool reports the real interval in each mode", async () => {
    await demo.from("tasks").delete().eq("opportunity_id", oppId);
    await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);

    await setDemo(false);
    const normal = await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "qualified" });
    assert.ok(normal.ok && "default_follow_up" in normal && normal.default_follow_up?.in === "two days");
    await demo.from("tasks").delete().eq("opportunity_id", oppId);
    await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);

    await setDemo(true);
    const fast = await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "qualified" });
    await demo.from("tasks").delete().eq("opportunity_id", oppId); // before the scheduler can see it
    assert.ok(fast.ok && "default_follow_up" in fast);
    assert.equal(fast.default_follow_up?.in, "about 30 seconds");
    assert.match(fast.note ?? "", /about 30 seconds/);
    await setDemo(false);
  });
});
