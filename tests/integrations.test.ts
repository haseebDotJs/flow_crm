/**
 * Outbound webhook + inbound lead API tests (real Supabase project).
 * The outbound tests POST demo data to https://httpbin.org (a public echo service) so the exact
 * bytes/headers received can be verified. Usage: npm run test:integrations
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

const admin = createClient(url, secret, opts);
const anon = createClient(url, publishable, opts);
let demo: SupabaseClient;
let other: SupabaseClient;
let demoId = "";
let otherId = "";
let oppId = "";
const createdContacts: string[] = [];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signIn(email: string, password: string) {
  const c = createClient(url, publishable, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null);
  return { client: c, id: data.user!.id };
}

async function deliveries(client: SupabaseClient) {
  const { data, error } = await client.rpc("list_webhook_deliveries", { p_limit: 50 });
  assert.equal(error, null);
  return (data ?? []) as {
    id: string;
    event: string;
    status_code: number | null;
    error: string | null;
    response_body: string | null;
  }[];
}

async function waitForDelivery(client: SupabaseClient, knownIds: Set<string>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const fresh = (await deliveries(client)).find((d) => !knownIds.has(d.id) && d.status_code !== null);
    if (fresh) return fresh;
    await sleep(1500);
  }
  throw new Error("Timed out waiting for webhook delivery result");
}

async function makeKey(client: SupabaseClient, name = "test key") {
  const key = `fcrm_${randomBytes(32).toString("base64url")}`;
  const { data, error } = await client
    .from("api_keys")
    .insert({ name, key_prefix: key.slice(0, 10), key_hash: sha256(key) })
    .select("id")
    .single();
  assert.equal(error, null);
  return { key, id: data!.id as string };
}

before(async () => {
  const d = await signIn("demo@flowcrm.test", "FlowCRM-demo-2026");
  demo = d.client;
  demoId = d.id;

  const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const email = `integ-other-${Date.now()}@flowcrm.test`;
  const created = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  otherId = created.data.user!.id;
  other = (await signIn(email, pw)).client;

  const { data: opp } = await demo.from("opportunities").select("id").eq("title", "Acme Enterprise License").single();
  oppId = opp!.id;
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await demo.from("webhook_endpoints").delete().eq("user_id", demoId);
});

after(async () => {
  await demo.from("webhook_endpoints").delete().eq("user_id", demoId);
  await admin.from("api_keys").delete().in("user_id", [demoId, otherId]); // users can only revoke, not delete
  await demo.from("contacts").delete().in("id", createdContacts);
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await admin.auth.admin.deleteUser(otherId);
});

describe("outbound webhook: endpoint rules", () => {
  it("rejects non-https, loopback, private and userinfo URLs", async () => {
    for (const bad of [
      "http://example.com/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://172.20.0.1/hook",
      "https://169.254.169.254/latest",
      "https://user@evil.com/hook",
      "ftp://example.com",
    ]) {
      const { error } = await demo.from("webhook_endpoints").insert({ url: bad });
      assert.ok(error, `should reject ${bad}`);
    }
  });

  it("generates a signing secret and keeps endpoints private to their owner", async () => {
    const { data, error } = await demo
      .from("webhook_endpoints")
      .insert({ url: "https://httpbin.org/post" })
      .select("id, secret, enabled, events")
      .single();
    assert.equal(error, null);
    assert.match(data!.secret, /^[0-9a-f]{48}$/);
    assert.equal(data!.enabled, true);
    const { data: seen } = await other.from("webhook_endpoints").select("id");
    assert.equal(seen?.length, 0);
    const forged = await other.from("webhook_endpoints").insert({ user_id: demoId, url: "https://httpbin.org/post" });
    assert.ok(forged.error, "cannot create an endpoint for another user");
  });
});

describe("outbound webhook: delivery", () => {
  it("sends a correctly signed event for a stage change", async () => {
    const { data: ep } = await demo.from("webhook_endpoints").select("secret").single();
    const known = new Set((await deliveries(demo)).map((d) => d.id));

    await demo.from("opportunities").update({ stage: "proposal" }).eq("id", oppId);
    const d = await waitForDelivery(demo, known);
    assert.equal(d.status_code, 200, `delivery status ${d.status_code} ${d.error ?? ""}`);

    // httpbin echoes exactly what it received.
    const echo = JSON.parse(d.response_body!);
    const h = Object.fromEntries(Object.entries(echo.headers).map(([k, v]) => [k.toLowerCase(), v as string]));
    assert.equal(h["x-flowcrm-event"], "opportunity.stage_changed");
    assert.equal(h["x-flowcrm-delivery"], d.id);

    const ts = h["x-flowcrm-timestamp"];
    assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 300, "timestamp is recent");
    const expected = "sha256=" + createHmac("sha256", ep!.secret).update(`${ts}.${echo.data}`).digest("hex");
    assert.equal(h["x-flowcrm-signature"], expected, "signature matches HMAC over '<ts>.<raw body>'");

    const body = JSON.parse(echo.data);
    assert.equal(body.event, "opportunity.stage_changed");
    assert.equal(body.id, d.id);
    assert.equal(body.data.opportunity.stage, "proposal");
    assert.equal(body.data.opportunity.previous_stage, "new");
    assert.equal(body.data.opportunity.title, "Acme Enterprise License");
    assert.equal(body.data.contact.name, "John Smith");
  });

  it("does not send for no-op updates or when the endpoint is disabled", async () => {
    const known = new Set((await deliveries(demo)).map((d) => d.id));
    await demo.from("opportunities").update({ stage: "proposal" }).eq("id", oppId); // no change
    await demo.from("webhook_endpoints").update({ enabled: false }).eq("user_id", demoId);
    await demo.from("opportunities").update({ stage: "negotiation" }).eq("id", oppId);
    await sleep(4000);
    const fresh = (await deliveries(demo)).filter((d) => !known.has(d.id));
    assert.equal(fresh.length, 0);
    await demo.from("webhook_endpoints").update({ enabled: true }).eq("user_id", demoId);
  });

  it("never blocks the CRM update when the receiver fails", async () => {
    await demo.from("webhook_endpoints").update({ url: "https://httpbin.org/status/500" }).eq("user_id", demoId);
    const known = new Set((await deliveries(demo)).map((d) => d.id));
    const { error } = await demo.from("opportunities").update({ stage: "won" }).eq("id", oppId);
    assert.equal(error, null);
    const { data } = await demo.from("opportunities").select("stage").eq("id", oppId).single();
    assert.equal(data?.stage, "won");
    const d = await waitForDelivery(demo, known);
    assert.equal(d.status_code, 500);
  });

  it("keeps the delivery log private to the owner", async () => {
    assert.equal((await deliveries(other)).length, 0);
    const direct = await other.from("webhook_deliveries").select("id");
    assert.equal(direct.data?.length, 0);
  });
});

describe("inbound lead API", () => {
  let key = "";
  let keyId = "";

  before(async () => {
    ({ key, id: keyId } = await makeKey(demo));
  });

  it("creates a contact and a New opportunity, attributed to the webhook", async () => {
    const email = `lead-${Date.now()}@example.com`;
    const { data, error } = await anon.rpc("ingest_lead", {
      p_key: key,
      p_payload: { name: "Ada Lovelace", email, company: "Analytical Engines", value: 12000, notes: "From landing page" },
    });
    assert.equal(error, null);
    assert.equal(data.ok, true);
    assert.equal(data.created_contact, true);
    createdContacts.push(data.contact_id);

    const { data: opp } = await demo.from("opportunities").select("title, stage, value, user_id").eq("id", data.opportunity_id).single();
    assert.equal(opp?.stage, "new");
    assert.equal(Number(opp?.value), 12000);
    assert.equal(opp?.title, "Analytical Engines - Inbound lead");
    assert.equal(opp?.user_id, demoId);

    const { data: logs } = await demo.from("activity_log").select("actor, entity_type").in("entity_id", [data.contact_id, data.opportunity_id]);
    assert.ok(logs!.length >= 2 && logs!.every((l) => l.actor === "webhook"));

    // Same email again: contact reused, a new opportunity added.
    const again = await anon.rpc("ingest_lead", { p_key: key, p_payload: { name: "Ada L.", email, opportunity_title: "Second deal" } });
    assert.equal(again.data.ok, true);
    assert.equal(again.data.created_contact, false);
    assert.equal(again.data.contact_id, data.contact_id);
    assert.notEqual(again.data.opportunity_id, data.opportunity_id);
  });

  it("rejects missing, malformed and unknown keys", async () => {
    for (const bad of ["", "short", "fcrm_" + "x".repeat(43), null]) {
      const { data } = await anon.rpc("ingest_lead", { p_key: bad, p_payload: { name: "X" } });
      assert.equal(data.ok, false);
      assert.equal(data.error, "invalid_api_key");
    }
  });

  it("rejects invalid payloads", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { name: "   " },
      { name: "Bob", email: "not-an-email" },
      { name: "Bob", value: -5 },
      { name: "Bob", value: "lots" },
      { name: "x".repeat(201) },
      { name: "Bob", notes: "n".repeat(2001) },
    ];
    for (const payload of cases) {
      const { data } = await anon.rpc("ingest_lead", { p_key: key, p_payload: payload });
      assert.equal(data.ok, false, JSON.stringify(payload).slice(0, 60));
      assert.equal(data.error, "invalid_payload");
    }
    const notObject = await anon.rpc("ingest_lead", { p_key: key, p_payload: [1, 2] });
    assert.equal(notObject.data.error, "invalid_payload");
  });

  it("rejects a revoked key", async () => {
    const rev = await makeKey(demo, "to revoke");
    await demo.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", rev.id);
    const { data } = await anon.rpc("ingest_lead", { p_key: rev.key, p_payload: { name: "Nope" } });
    assert.equal(data.error, "invalid_api_key");
  });

  it("writes only to the key owner's data", async () => {
    const otherKey = await makeKey(other, "other key");
    const { data } = await anon.rpc("ingest_lead", { p_key: otherKey.key, p_payload: { name: "Other Lead" } });
    assert.equal(data.ok, true);
    const mine = await demo.from("contacts").select("id").eq("id", data.contact_id);
    assert.equal(mine.data?.length, 0, "demo user must not see it");
    const theirs = await other.from("contacts").select("id").eq("id", data.contact_id);
    assert.equal(theirs.data?.length, 1);
  });

  it("never exposes key hashes, and keys are private to their owner", async () => {
    const hashRead = await demo.from("api_keys").select("key_hash");
    assert.ok(hashRead.error, "key_hash must not be selectable");
    const { data: seen } = await other.from("api_keys").select("id").eq("id", keyId);
    assert.equal(seen?.length, 0);
    const { data: list } = await demo.from("api_keys").select("id, name, key_prefix, last_used_at").eq("id", keyId).single();
    assert.ok(list?.last_used_at, "last_used_at is updated on use");
  });

  it("gives anonymous callers no direct table access", async () => {
    for (const t of ["contacts", "opportunities", "api_keys", "webhook_endpoints", "activity_log"]) {
      const { data, error } = await anon.from(t).select("id");
      assert.ok(error || (data?.length ?? 0) === 0, `${t} must not be readable anonymously`);
    }
  });
});
