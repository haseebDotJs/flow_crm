/**
 * RLS / integrity checks against the real Supabase project.
 * Usage: npm run test:rls   (needs the seeded demo user and .env.local)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const DEMO_EMAIL = "demo@flowcrm.test";
const DEMO_PASSWORD = "FlowCRM-demo-2026";

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, opts);

const otherEmail = `rls-other-${Date.now()}@flowcrm.test`;
const otherPassword = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
let otherId = "";
let demo: SupabaseClient;
let other: SupabaseClient;
let demoOppId = "";
let demoContactId = "";

async function signIn(email: string, password: string) {
  const c = createClient(url, publishable, opts);
  const { error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `sign-in failed for ${email}`);
  return c;
}

before(async () => {
  const created = await admin.auth.admin.createUser({
    email: otherEmail,
    password: otherPassword,
    email_confirm: true,
  });
  assert.equal(created.error, null);
  otherId = created.data.user!.id;

  demo = await signIn(DEMO_EMAIL, DEMO_PASSWORD);
  other = await signIn(otherEmail, otherPassword);

  const { data: opp } = await demo.from("opportunities").select("id, contact_id").eq("title", "Acme Enterprise License").single();
  demoOppId = opp!.id;
  demoContactId = opp!.contact_id;
});

after(async () => {
  if (otherId) await admin.auth.admin.deleteUser(otherId);
});

describe("RLS", () => {
  it("creates a profile row on signup", async () => {
    const { data } = await other.from("profiles").select("id").eq("id", otherId);
    assert.equal(data?.length, 1);
  });

  it("demo user sees seeded data", async () => {
    const { data } = await demo.from("contacts").select("id");
    assert.ok((data?.length ?? 0) >= 4);
  });

  it("anon sees nothing", async () => {
    const anon = createClient(url, publishable, opts);
    const { data, error } = await anon.from("contacts").select("id");
    assert.ok(error !== null || (data?.length ?? 0) === 0);
  });

  it("another user sees none of the demo data", async () => {
    for (const table of ["contacts", "opportunities", "tasks"]) {
      const { data } = await other.from(table).select("id");
      assert.equal(data?.length, 0, `${table} leaked`);
    }
  });

  it("another user cannot update or delete demo rows", async () => {
    const upd = await other.from("opportunities").update({ stage: "lost" }).eq("id", demoOppId).select();
    assert.equal(upd.data?.length ?? 0, 0);
    const del = await other.from("opportunities").delete().eq("id", demoOppId).select();
    assert.equal(del.data?.length ?? 0, 0);
    const { data } = await admin.from("opportunities").select("stage").eq("id", demoOppId).single();
    assert.notEqual(data?.stage, "lost");
  });

  it("cannot insert a row owned by someone else", async () => {
    const { error } = await other.from("contacts").insert({ user_id: (await demo.auth.getUser()).data.user!.id, name: "Evil" });
    assert.ok(error, "insert with foreign user_id should fail");
  });

  it("cannot link own records to another user's contact", async () => {
    const { error } = await other
      .from("tasks")
      .insert({ title: "cross-link", contact_id: demoContactId, due_at: new Date().toISOString() });
    assert.ok(error, "cross-user contact reference should fail");
  });
});

describe("Integrity", () => {
  it("rejects invalid stages", async () => {
    const { error } = await demo.from("opportunities").update({ stage: "bogus" }).eq("id", demoOppId);
    assert.ok(error);
  });

  it("rejects duplicate pending follow-ups", async () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const row = { title: "dup-test", contact_id: demoContactId, opportunity_id: demoOppId, due_at: due };
    const first = await demo.from("tasks").insert(row).select("id").single();
    assert.equal(first.error, null);
    const second = await demo.from("tasks").insert(row);
    assert.ok(second.error, "duplicate should violate unique index");
    await demo.from("tasks").delete().eq("id", first.data!.id);
  });
});
