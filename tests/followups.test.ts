/**
 * Follow-up lifecycle via the voice tools: existing-follow-up guard, find, reschedule, cancel.
 * Usage: npm run test:followups
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cancelFollowUp,
  createFollowUp,
  findFollowUps,
  rescheduleFollowUp,
  type CrmContext,
} from "../agent/crm";
import { parseDueAt } from "../agent/datetime";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const TZ = "Europe/Warsaw";

let db: SupabaseClient;
let ctx: CrmContext;
let otherCtx: CrmContext;
let otherId = "";
let contactId = "";
let oppId = "";

const day = (n: number, time = "09:00:00") => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10) + `T${time}`;
const reset = async () => {
  await db.from("tasks").delete().eq("opportunity_id", oppId);
  await db.from("opportunities").update({ stage: "new" }).eq("id", oppId);
};
const pending = async () => {
  const { data } = await db.from("tasks").select("id, title, due_at, status, source").eq("opportunity_id", oppId).order("created_at");
  return data ?? [];
};

before(async () => {
  db = createClient(url, publishable, opts);
  const { data, error } = await db.auth.signInWithPassword({ email: "demo@flowcrm.test", password: "FlowCRM-demo-2026" });
  assert.equal(error, null);
  ctx = { db, userId: data.user!.id, timeZone: TZ };

  const admin = createClient(url, secret, opts);
  const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const email = `followups-other-${Date.now()}@flowcrm.test`;
  const created = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  otherId = created.data.user!.id;
  const otherDb = createClient(url, publishable, opts);
  await otherDb.auth.signInWithPassword({ email, password: pw });
  otherCtx = { db: otherDb, userId: otherId, timeZone: TZ };

  const { data: opp } = await db.from("opportunities").select("id, contact_id").eq("title", "Acme Enterprise License").single();
  oppId = opp!.id;
  contactId = opp!.contact_id;
  await reset();
});

after(async () => {
  await reset();
  await createClient(url, secret, opts).auth.admin.deleteUser(otherId);
});

describe("existing follow-up guard", () => {
  it("refuses a second follow-up on the same deal until the user chooses", async () => {
    await reset();
    const first = await createFollowUp(ctx, { contact_id: contactId, opportunity_id: oppId, title: "Follow up with John Smith", due_at: day(1, "09:00:00") });
    assert.ok(first.ok);

    // The exact scenario from the field: "create a follow-up at 9 PM" while a 9 AM one exists.
    const second = await createFollowUp(ctx, { contact_id: contactId, opportunity_id: oppId, title: "Follow up with John Smith", due_at: day(1, "21:00:00") });
    assert.ok(!second.ok && second.code === "follow_up_exists");
    assert.ok("existing" in second && second.existing[0].id === first.task.id);
    assert.equal((await pending()).length, 1, "nothing was created");
  });

  it("allows an additional follow-up only when explicitly requested", async () => {
    const r = await createFollowUp(ctx, { contact_id: contactId, opportunity_id: oppId, title: "Second touchpoint", due_at: day(2, "10:00:00"), add_another: true });
    assert.ok(r.ok);
    assert.equal((await pending()).length, 2);
  });
});

describe("find_follow_ups", () => {
  it("lists pending follow-ups for a deal and for a contact", async () => {
    const byOpp = await findFollowUps(ctx, { opportunity_id: oppId });
    assert.ok(byOpp.ok && byOpp.status === "multiple" && byOpp.follow_ups.length === 2);
    assert.ok(byOpp.follow_ups[0].spoken_due.length > 5);
    const byContact = await findFollowUps(ctx, { contact_id: contactId });
    assert.ok(byContact.ok && byContact.follow_ups.length >= 2);
  });
  it("needs a contact or opportunity, and ignores other users' data", async () => {
    assert.equal((await findFollowUps(ctx, {})).ok, false);
    const r = await findFollowUps(otherCtx, { opportunity_id: oppId });
    assert.ok(r.ok && r.status === "none");
  });
});

describe("reschedule_follow_up", () => {
  it("moves the same task to the new time without creating another", async () => {
    await reset();
    const created = await createFollowUp(ctx, { contact_id: contactId, opportunity_id: oppId, title: "Follow up with John Smith", due_at: day(1, "09:00:00") });
    assert.ok(created.ok);
    const newTime = day(1, "21:00:00");

    const r = await rescheduleFollowUp(ctx, { task_id: created.task.id, due_at: newTime });
    assert.ok(r.ok);
    assert.equal(r.task.id, created.task.id);
    assert.equal(new Date(r.task.due_at).toISOString(), parseDueAt(newTime, TZ)!.toISOString());

    const rows = await pending();
    assert.equal(rows.length, 1, "still exactly one follow-up");
    assert.equal(new Date(rows[0].due_at).toISOString(), parseDueAt(newTime, TZ)!.toISOString());
  });

  it("refuses guessed/past times, unknown tasks and other users' tasks", async () => {
    const [task] = await pending();
    assert.ok(!(await rescheduleFollowUp(ctx, { task_id: task.id, due_at: day(2), time_source: "not_specified" })).ok);
    assert.ok(!(await rescheduleFollowUp(ctx, { task_id: task.id, due_at: day(2).slice(0, 10) })).ok, "date-only has no time");
    const past = await rescheduleFollowUp(ctx, { task_id: task.id, due_at: "2020-01-01T10:00:00" });
    assert.ok(!past.ok && past.code === "date_in_past");
    const missing = await rescheduleFollowUp(ctx, { task_id: "00000000-0000-4000-8000-000000000000", due_at: day(2, "10:00:00") });
    assert.ok(!missing.ok && missing.code === "not_found");
    const foreign = await rescheduleFollowUp(otherCtx, { task_id: task.id, due_at: day(2, "10:00:00") });
    assert.ok(!foreign.ok && foreign.code === "not_found");
  });
});

describe("cancel_follow_up", () => {
  it("cancels (not deletes) a pending follow-up, once", async () => {
    const [task] = await pending();
    const foreign = await cancelFollowUp(otherCtx, { task_id: task.id });
    assert.ok(!foreign.ok, "another user cannot cancel it");

    const r = await cancelFollowUp(ctx, { task_id: task.id });
    assert.ok(r.ok);
    const rows = await pending();
    assert.equal(rows.length, 1, "the row is kept");
    assert.equal(rows[0].status, "cancelled");

    const again = await cancelFollowUp(ctx, { task_id: task.id });
    assert.ok(!again.ok && again.code === "not_pending");
    const resched = await rescheduleFollowUp(ctx, { task_id: task.id, due_at: day(3, "10:00:00") });
    assert.ok(!resched.ok && resched.code === "not_pending");

    const open = await findFollowUps(ctx, { opportunity_id: oppId });
    assert.ok(open.ok && open.status === "none", "cancelled tasks are not listed as pending");
  });

  it("records reschedule and cancel in the activity log", async () => {
    const [task] = await pending();
    const { data } = await db.from("activity_log").select("action").eq("entity_id", task.id).order("created_at");
    const actions = data!.map((l) => l.action);
    assert.ok(actions.includes("rescheduled") && actions.includes("cancelled"), actions.join(","));
  });
});
