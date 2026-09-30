/**
 * New -> Qualified automation: DB trigger + hand-off with the Voice AI follow-up tool.
 * Usage: npm run test:automation
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createFollowUp, type CrmContext } from "../agent/crm";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

let db: SupabaseClient;
let ctx: CrmContext;
let oppId = "";
let contactId = "";

const setStage = async (stage: string) => {
  const { error } = await db.from("opportunities").update({ stage }).eq("id", oppId);
  assert.equal(error, null);
};
const pendingTasks = async () => {
  const { data } = await db
    .from("tasks")
    .select("id, title, due_at, source, status")
    .eq("opportunity_id", oppId)
    .eq("status", "pending");
  return data ?? [];
};
const reset = async () => {
  await db.from("tasks").delete().eq("opportunity_id", oppId);
  await setStage("new");
};

before(async () => {
  db = createClient(url, publishable, opts);
  const { data, error } = await db.auth.signInWithPassword({
    email: "demo@flowcrm.test",
    password: "FlowCRM-demo-2026",
  });
  assert.equal(error, null);
  ctx = { db, userId: data.user!.id, timeZone: "Europe/Warsaw" };
  const { data: opp } = await db
    .from("opportunities")
    .select("id, contact_id")
    .eq("title", "Acme Enterprise License")
    .single();
  oppId = opp!.id;
  contactId = opp!.contact_id;
});

after(reset);

describe("New -> Qualified automation", () => {
  it("creates exactly one 'Follow up with <contact>' task ~2 days out", async () => {
    await reset();
    await setStage("qualified");
    const tasks = await pendingTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Follow up with John Smith");
    assert.equal(tasks[0].source, "automation");
    const days = (new Date(tasks[0].due_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 1.9 && days < 2.1, `due in ${days.toFixed(2)} days`);
  });

  it("does not create a second task when the stage flip-flops", async () => {
    await setStage("new");
    await setStage("qualified");
    assert.equal((await pendingTasks()).length, 1);
  });

  it("ignores other transitions", async () => {
    await reset();
    await setStage("proposal");
    await setStage("qualified"); // proposal -> qualified is not New -> Qualified
    assert.equal((await pendingTasks()).length, 0);
  });

  it("creates a fresh task once the previous one is completed", async () => {
    await reset();
    await setStage("qualified");
    await db.from("tasks").update({ status: "completed" }).eq("opportunity_id", oppId);
    await setStage("new");
    await setStage("qualified");
    assert.equal((await pendingTasks()).length, 1);
  });
});

describe("Voice follow-up hand-off", () => {
  it("adopts the automatic task instead of creating a duplicate", async () => {
    await reset();
    await setStage("qualified"); // automation task now exists
    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T10:00:00";

    const r = await createFollowUp(ctx, {
      contact_id: contactId,
      opportunity_id: oppId,
      title: "Follow up with John Smith",
      due_at: due,
    });
    assert.ok(r.ok && "adopted_automation" in r && r.adopted_automation);

    const tasks = await pendingTasks();
    assert.equal(tasks.length, 1, "exactly one pending task");
    assert.equal(tasks[0].source, "manual");
    assert.equal(new Date(tasks[0].due_at).toISOString(), new Date(r.task.due_at).toISOString());
    // ~1 day out, not the automation's 2 days
    const days = (new Date(tasks[0].due_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days < 1.9);
  });

  it("repeating the voice call stays idempotent", async () => {
    const tasks = await pendingTasks();
    const due = tasks[0].due_at;
    const again = await createFollowUp(ctx, {
      contact_id: contactId,
      opportunity_id: oppId,
      title: tasks[0].title,
      due_at: due,
    });
    assert.ok(again.ok && again.duplicate);
    assert.equal((await pendingTasks()).length, 1);
  });

  it("creates a normal task when no automation task exists", async () => {
    await reset();
    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T11:00:00";
    const r = await createFollowUp(ctx, { contact_id: contactId, opportunity_id: oppId, title: "Plain", due_at: due });
    assert.ok(r.ok && !("adopted_automation" in r));
    assert.equal((await pendingTasks()).length, 1);
  });
});
