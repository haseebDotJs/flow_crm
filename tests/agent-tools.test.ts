/**
 * Voice-agent CRM tool tests (real Supabase project, signed in as the seeded demo user).
 * Usage: npm run test:agent
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createFollowUp,
  findContact,
  findOpportunities,
  updateOpportunityStage,
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
let johnId = "";
let oppId = "";
const createdTaskIds: string[] = [];
const createdContactIds: string[] = [];
let otherUserId = "";
let otherCtx: CrmContext;

before(async () => {
  db = createClient(url, publishable, opts);
  const { data, error } = await db.auth.signInWithPassword({
    email: "demo@flowcrm.test",
    password: "FlowCRM-demo-2026",
  });
  assert.equal(error, null);
  ctx = { db, userId: data.user!.id, timeZone: TZ };

  const admin = createClient(url, secret, opts);
  const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const email = `agent-other-${Date.now()}@flowcrm.test`;
  const created = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  otherUserId = created.data.user!.id;
  const otherDb = createClient(url, publishable, opts);
  await otherDb.auth.signInWithPassword({ email, password: pw });
  otherCtx = { db: otherDb, userId: otherUserId, timeZone: TZ };

  const c = await findContact(ctx, { name: "John Smith" });
  assert.ok(c.ok && c.status === "found");
  johnId = c.contacts[0].id;
  const o = await findOpportunities(ctx, { contact_id: johnId });
  assert.ok(o.ok);
  oppId = o.opportunities[0].id;
  // make sure the scenario starts from `new`
  await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "new" });
});

after(async () => {
  await db.from("tasks").delete().in("id", createdTaskIds);
  await db.from("contacts").delete().in("id", createdContactIds);
  await db.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await createClient(url, secret, opts).auth.admin.deleteUser(otherUserId);
});

describe("datetime", () => {
  it("interprets naive times in the user's timezone (CEST = UTC+2)", () => {
    assert.equal(parseDueAt("2026-10-02T10:00:00", TZ)?.toISOString(), "2026-10-02T08:00:00.000Z");
  });
  it("interprets naive winter times (CET = UTC+1)", () => {
    assert.equal(parseDueAt("2026-12-02T10:00:00", TZ)?.toISOString(), "2026-12-02T09:00:00.000Z");
  });
  it("defaults date-only input to 09:00 local and tolerates decoration", () => {
    assert.equal(parseDueAt("2026-10-02", TZ)?.toISOString(), "2026-10-02T07:00:00.000Z");
    assert.equal(parseDueAt("2026-10-02T09:30 (tomorrow)", TZ)?.toISOString(), "2026-10-02T07:30:00.000Z");
  });
  it("honours explicit offsets and rejects garbage / impossible dates", () => {
    assert.equal(parseDueAt("2026-10-02T10:00:00Z", TZ)?.toISOString(), "2026-10-02T10:00:00.000Z");
    assert.equal(parseDueAt("tomorrow", TZ), null);
    assert.equal(parseDueAt("2026-02-31T10:00:00", TZ), null);
  });
});

describe("find_contact", () => {
  it("finds a single contact", async () => {
    const r = await findContact(ctx, { name: "john smith" });
    assert.ok(r.ok && r.status === "found");
    assert.equal(r.contacts[0].company, "Acme Inc.");
  });
  it("reports not_found", async () => {
    const r = await findContact(ctx, { name: "Nobody Atall" });
    assert.ok(r.ok && r.status === "not_found");
  });
  it("reports multiple for ambiguous matches", async () => {
    const ins = await db
      .from("contacts")
      .insert({ user_id: ctx.userId, name: "John Smith", company: "Other Co" })
      .select("id")
      .single();
    createdContactIds.push(ins.data!.id);
    const r = await findContact(ctx, { name: "John Smith" });
    assert.ok(r.ok && r.status === "multiple");
    const narrowed = await findContact(ctx, { name: "John Smith", company: "Acme" });
    assert.ok(narrowed.ok && narrowed.status === "found");
    await db.from("contacts").delete().eq("id", ins.data!.id);
  });
  it("does not leak another user's contacts and survives hostile input", async () => {
    const r = await findContact(otherCtx, { name: "John Smith" });
    assert.ok(r.ok && r.status === "not_found");
    const hostile = await findContact(ctx, { name: "x%'); DROP TABLE contacts;--" });
    assert.ok(hostile.ok);
  });
});

describe("find_opportunities", () => {
  it("returns the contact's opportunity", async () => {
    const r = await findOpportunities(ctx, { contact_id: johnId });
    assert.ok(r.ok && r.status === "single");
    assert.equal(r.opportunities[0].title, "Acme Enterprise License");
  });
  it("rejects malformed ids and other users' contacts", async () => {
    assert.equal((await findOpportunities(ctx, { contact_id: "nope" })).ok, false);
    assert.equal((await findOpportunities(otherCtx, { contact_id: johnId })).ok, false);
  });
  it("supports stage filter", async () => {
    const r = await findOpportunities(ctx, { contact_id: johnId, stage: "won" });
    assert.ok(r.ok && r.status === "none");
  });
});

describe("update_opportunity_stage", () => {
  it("rejects invalid stages", async () => {
    const r = await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "bogus" });
    assert.equal(r.ok, false);
  });
  it("refuses another user's opportunity", async () => {
    const r = await updateOpportunityStage(otherCtx, { opportunity_id: oppId, stage: "lost" });
    assert.equal(r.ok, false);
    const { data } = await db.from("opportunities").select("stage").eq("id", oppId).single();
    assert.equal(data?.stage, "new");
  });
  it("moves New -> Qualified and reports the change", async () => {
    const r = await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "qualified" });
    assert.ok(r.ok && r.changed);
    assert.equal(r.opportunity.stage, "qualified");
    assert.equal(r.opportunity.previous_stage, "new");
    const { data } = await db.from("opportunities").select("stage").eq("id", oppId).single();
    assert.equal(data?.stage, "qualified");
  });
  it("is a no-op when already in the stage", async () => {
    const r = await updateOpportunityStage(ctx, { opportunity_id: oppId, stage: "qualified" });
    assert.ok(r.ok && r.changed === false);
  });
});

describe("create_follow_up", () => {
  const future = () => {
    const d = new Date(Date.now() + 2 * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T10:00:00`;
  };

  it("creates the task at the right instant and is idempotent", async () => {
    const input = { contact_id: johnId, opportunity_id: oppId, title: `Test follow-up ${Date.now()}`, due_at: future() };
    const a = await createFollowUp(ctx, input);
    assert.ok(a.ok && !a.duplicate);
    createdTaskIds.push(a.task.id);
    assert.equal(new Date(a.task.due_at).toISOString(), parseDueAt(input.due_at, TZ)!.toISOString());

    const b = await createFollowUp(ctx, input); // repeated tool call
    assert.ok(b.ok && b.duplicate);
    assert.equal(b.task.id, a.task.id);

    const { data } = await db.from("tasks").select("id").eq("opportunity_id", oppId).eq("title", input.title);
    assert.equal(data?.length, 1);
  });
  it("accepts a date-only due_at and blank/null optional opportunity_id", async () => {
    const d = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const r = await createFollowUp(ctx, { contact_id: johnId, opportunity_id: "", title: "date-only test", due_at: d });
    assert.ok(r.ok);
    createdTaskIds.push(r.task.id);
    assert.equal(new Date(r.task.due_at).toISOString(), parseDueAt(d, TZ)!.toISOString());
  });
  it("names the offending field when input is invalid", async () => {
    const r = await createFollowUp(ctx, { contact_id: johnId, title: "x" });
    assert.ok(!r.ok && r.code === "invalid_input" && r.message.includes("due_at"));
  });
  it("rejects past dates, bad dates and mismatched records", async () => {
    const base = { contact_id: johnId, opportunity_id: oppId, title: "x" };
    assert.equal((await createFollowUp(ctx, { ...base, due_at: "2020-01-01T10:00:00" })).ok, false);
    assert.equal((await createFollowUp(ctx, { ...base, due_at: "tomorrow" })).ok, false);
    const other = await findContact(ctx, { name: "Sarah Williams" });
    assert.ok(other.ok);
    const mismatch = await createFollowUp(ctx, { ...base, contact_id: other.contacts[0].id, due_at: future() });
    assert.ok(!mismatch.ok && mismatch.code === "mismatch");
  });
  it("refuses another user's records", async () => {
    const r = await createFollowUp(otherCtx, { contact_id: johnId, title: "x", due_at: future() });
    assert.equal(r.ok, false);
  });
});
