/**
 * Activity log + role field tests (real Supabase project).
 * Usage: npm run test:activity
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createFollowUp } from "../agent/crm";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

const admin = createClient(url, secret, opts);
let demo: SupabaseClient;
let voice: SupabaseClient;
let spoofed: SupabaseClient;
let demoId = "";
let oppId = "";
let contactId = "";
let otherId = "";
let other: SupabaseClient;
const createdContacts: string[] = [];

async function signIn(headers?: Record<string, string>) {
  const c = createClient(url, publishable, { ...opts, global: { headers } });
  const { data, error } = await c.auth.signInWithPassword({
    email: "demo@flowcrm.test",
    password: "FlowCRM-demo-2026",
  });
  assert.equal(error, null);
  return { client: c, id: data.user!.id };
}

const logsFor = async (entityId: string) => {
  const { data, error } = await demo
    .from("activity_log")
    .select("action, summary, actor, metadata, entity_type")
    .eq("entity_id", entityId)
    .order("created_at", { ascending: true });
  assert.equal(error, null);
  return data ?? [];
};

before(async () => {
  const d = await signIn();
  demo = d.client;
  demoId = d.id;
  voice = (await signIn({ "x-flowcrm-actor": "voice" })).client;
  spoofed = (await signIn({ "x-flowcrm-actor": "admin" })).client;

  const { data: opp } = await demo.from("opportunities").select("id, contact_id").eq("title", "Acme Enterprise License").single();
  oppId = opp!.id;
  contactId = opp!.contact_id;
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);

  const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const email = `activity-other-${Date.now()}@flowcrm.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
    user_metadata: { full_name: "Other", role: "admin" }, // must NOT grant a role
  });
  otherId = created.data.user!.id;
  other = createClient(url, publishable, opts);
  await other.auth.signInWithPassword({ email, password: pw });
});

after(async () => {
  await demo.from("contacts").delete().in("id", createdContacts);
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await admin.auth.admin.deleteUser(otherId);
});

describe("activity log: what gets recorded", () => {
  it("logs contact create / update / delete", async () => {
    const ins = await demo.from("contacts").insert({ user_id: demoId, name: "Log Test" }).select("id").single();
    const id = ins.data!.id;
    createdContacts.push(id);
    await demo.from("contacts").update({ company: "Logco" }).eq("id", id);
    await demo.from("contacts").delete().eq("id", id);

    const logs = await logsFor(id);
    assert.deepEqual(logs.map((l) => l.action), ["created", "updated", "deleted"]);
    assert.ok(logs.every((l) => l.actor === "user" && l.entity_type === "contact"));
    assert.deepEqual((logs[1].metadata as { changed: string[] }).changed, ["company"]);
    assert.equal(logs[0].summary, "Created contact Log Test");
  });

  it("logs stage changes with from/to and a readable summary", async () => {
    await demo.from("opportunities").update({ stage: "proposal" }).eq("id", oppId);
    const logs = await logsFor(oppId);
    const last = logs[logs.length - 1];
    assert.equal(last.action, "stage_changed");
    assert.equal(last.summary, "Moved Acme Enterprise License from New to Proposal");
    assert.equal(last.metadata.from, "new");
    assert.equal(last.metadata.to, "proposal");
  });

  it("records who and what: title, contact and company travel with each entry", async () => {
    const last = (await logsFor(oppId)).at(-1)!;
    assert.deepEqual(
      { title: last.metadata.title, contact: last.metadata.contact, company: last.metadata.company },
      { title: "Acme Enterprise License", contact: "John Smith", company: "Acme Inc." },
    );

    const t = await demo
      .from("tasks")
      .insert({ user_id: demoId, title: "Context task", opportunity_id: oppId, contact_id: contactId, due_at: new Date(Date.now() + 86_400_000).toISOString() })
      .select("id")
      .single();
    const taskLog = (await logsFor(t.data!.id))[0];
    assert.equal(taskLog.metadata.title, "Context task");
    assert.equal(taskLog.metadata.contact, "John Smith");
    assert.equal(taskLog.metadata.opportunity, "Acme Enterprise License");
    await demo.from("tasks").delete().eq("id", t.data!.id);
  });

  it("does not log no-op updates", async () => {
    const before = (await logsFor(oppId)).length;
    await demo.from("opportunities").update({ stage: "proposal" }).eq("id", oppId);
    assert.equal((await logsFor(oppId)).length, before);
  });

  it("logs task completion", async () => {
    const t = await demo
      .from("tasks")
      .insert({ user_id: demoId, title: "Activity task", opportunity_id: oppId, contact_id: contactId, due_at: new Date(Date.now() + 86_400_000).toISOString() })
      .select("id")
      .single();
    await demo.from("tasks").update({ status: "completed" }).eq("id", t.data!.id);
    const logs = await logsFor(t.data!.id);
    assert.deepEqual(logs.map((l) => l.action), ["created", "completed"]);
  });
});

describe("activity log: actor attribution", () => {
  it("labels changes made with the voice marker header as 'voice'", async () => {
    await voice.from("opportunities").update({ stage: "negotiation" }).eq("id", oppId);
    const last = (await logsFor(oppId)).at(-1)!;
    assert.equal(last.actor, "voice");
  });

  it("treats unknown marker values as a plain user", async () => {
    await spoofed.from("opportunities").update({ stage: "proposal" }).eq("id", oppId);
    assert.equal((await logsFor(oppId)).at(-1)!.actor, "user");
  });

  it("attributes the New -> Qualified follow-up to automation, and its hand-off to voice", async () => {
    await demo.from("tasks").delete().eq("opportunity_id", oppId);
    await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
    await voice.from("opportunities").update({ stage: "qualified" }).eq("id", oppId);

    const { data: auto } = await demo.from("tasks").select("id").eq("opportunity_id", oppId).eq("source", "automation").single();
    const autoLogs = await logsFor(auto!.id);
    assert.equal(autoLogs[0].action, "created");
    assert.equal(autoLogs[0].actor, "automation");

    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T10:00:00";
    const r = await createFollowUp(
      { db: voice, userId: demoId, timeZone: "Europe/Warsaw" },
      { contact_id: contactId, opportunity_id: oppId, title: "Follow up with John Smith", due_at: due },
    );
    assert.ok(r.ok);
    const after = await logsFor(auto!.id);
    const resched = after.find((l) => l.action === "rescheduled");
    assert.ok(resched, "adopting the automatic task is logged as a reschedule");
    assert.equal(resched!.actor, "voice");
  });
});

describe("activity log: access control", () => {
  it("another user sees none of it", async () => {
    const { data } = await other.from("activity_log").select("id");
    assert.equal(data?.length, 0);
  });

  it("users cannot write, edit or delete log entries", async () => {
    const ins = await demo
      .from("activity_log")
      .insert({ user_id: demoId, entity_type: "task", entity_id: oppId, action: "fake", summary: "forged" });
    assert.ok(ins.error, "insert must be rejected");
    const upd = await demo.from("activity_log").update({ summary: "tampered" }).eq("user_id", demoId).select();
    assert.ok(upd.error || (upd.data?.length ?? 0) === 0);
    const del = await demo.from("activity_log").delete().eq("user_id", demoId).select();
    assert.ok(del.error || (del.data?.length ?? 0) === 0);
    const { data } = await demo.from("activity_log").select("id").eq("summary", "forged");
    assert.equal(data?.length, 0);
  });

  it("deleting a user with data still works (log rows cascade)", async () => {
    const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
    const email = `cascade-${Date.now()}@flowcrm.test`;
    const u = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
    const c = createClient(url, publishable, opts);
    await c.auth.signInWithPassword({ email, password: pw });
    await c.from("contacts").insert({ user_id: u.data.user!.id, name: "Temp" });
    const del = await admin.auth.admin.deleteUser(u.data.user!.id);
    assert.equal(del.error, null);
    const { data } = await admin.from("activity_log").select("id").eq("user_id", u.data.user!.id);
    assert.equal(data?.length, 0);
  });
});

describe("role field", () => {
  it("defaults to member and ignores a role in signup metadata", async () => {
    const { data } = await other.from("profiles").select("role").eq("id", otherId).single();
    assert.equal(data?.role, "member");
  });

  it("seeded demo user is an admin", async () => {
    const { data } = await demo.from("profiles").select("role").eq("id", demoId).single();
    assert.equal(data?.role, "admin");
  });

  it("users cannot change their own role, but can edit their name", async () => {
    const promote = await other.from("profiles").update({ role: "admin" }).eq("id", otherId).select();
    assert.ok(promote.error, "role update must be rejected");
    const { data } = await other.from("profiles").select("role").eq("id", otherId).single();
    assert.equal(data?.role, "member");

    const rename = await other.from("profiles").update({ full_name: "Renamed" }).eq("id", otherId).select();
    assert.equal(rename.error, null);
    assert.equal(rename.data?.[0].full_name, "Renamed");
  });

  it("rejects invalid roles at the database level", async () => {
    const { error } = await admin.from("profiles").update({ role: "superuser" }).eq("id", otherId);
    assert.ok(error);
  });
});
