/**
 * App-layer integration tests: SSRF guard + the public lead endpoint over real HTTP.
 * The HTTP tests need the web app running (npm run dev) and are skipped otherwise.
 * Usage: npm run test:integrations-app
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkWebhookUrl, signPayload } from "../lib/webhooks";

config({ path: ".env.local", quiet: true });

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe("SSRF guard (checkWebhookUrl)", () => {
  it("accepts a public https URL", async () => {
    assert.equal(await checkWebhookUrl("https://httpbin.org/post"), null);
  });
  it("rejects http, credentials, localhost and private/link-local/metadata addresses", async () => {
    for (const bad of [
      "http://httpbin.org/post",
      "https://user:pw@httpbin.org/post",
      "https://localhost/hook",
      "https://app.localhost/hook",
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://172.16.0.1/hook",
      "https://192.168.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/hook",
      "https://[::1]/hook",
      "https://[fd00::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:a9fe:a9fe]/hook",
      "https://[::127.0.0.1]/hook",
      "https://[fe80::1]/hook",
      "https://[64:ff9b::7f00:1]/hook",
      "https://[::]/hook",
      "not a url",
    ]) {
      assert.notEqual(await checkWebhookUrl(bad), null, `should reject ${bad}`);
    }
  });
  it("signs payloads deterministically", () => {
    const a = signPayload("secret", "1700000000", '{"a":1}');
    assert.match(a, /^sha256=[0-9a-f]{64}$/);
    assert.equal(a, signPayload("secret", "1700000000", '{"a":1}'));
    assert.notEqual(a, signPayload("secret", "1700000001", '{"a":1}'));
  });
});

describe("POST /api/webhooks/leads", async () => {
  let up = true;
  try {
    await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    up = false;
  }
  const skip = up ? false : `web app not running at ${BASE}`;

  let demo: SupabaseClient;
  let demoId = "";
  let key = "";
  const contacts: string[] = [];

  before(async () => {
    if (!up) return;
    demo = createClient(url, publishable, opts);
    const { data } = await demo.auth.signInWithPassword({ email: "demo@flowcrm.test", password: "FlowCRM-demo-2026" });
    demoId = data.user!.id;
    key = `fcrm_${randomBytes(32).toString("base64url")}`;
    const { error } = await demo.from("api_keys").insert({
      name: "http test",
      key_prefix: key.slice(0, 10),
      key_hash: createHash("sha256").update(key).digest("hex"),
    });
    assert.equal(error, null);
  });

  after(async () => {
    if (!up) return;
    await demo.from("contacts").delete().in("id", contacts);
    await createClient(url, process.env.SUPABASE_SECRET_KEY!, opts).from("api_keys").delete().eq("user_id", demoId); // users can only revoke
  });

  const post = (body: unknown, headers: Record<string, string> = {}, raw = false) =>
    fetch(`${BASE}/api/webhooks/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  it("201 + ids for a valid lead (Bearer auth)", { skip }, async () => {
    const res = await post(
      { name: "HTTP Lead", email: `http-${Date.now()}@example.com`, company: "Webco", value: 5000 },
      { Authorization: `Bearer ${key}` },
    );
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.ok, true);
    contacts.push(json.contact_id);
    const { data } = await demo.from("opportunities").select("stage, value").eq("id", json.opportunity_id).single();
    assert.equal(data?.stage, "new");
    assert.equal(Number(data?.value), 5000);
  });

  it("accepts the X-API-Key header too", { skip }, async () => {
    const res = await post({ name: "Header Lead" }, { "X-API-Key": key });
    assert.equal(res.status, 201);
    contacts.push((await res.json()).contact_id);
  });

  it("401 without or with a wrong key", { skip }, async () => {
    assert.equal((await post({ name: "x" })).status, 401);
    assert.equal((await post({ name: "x" }, { Authorization: "Bearer fcrm_" + "a".repeat(43) })).status, 401);
  });

  it("422 for invalid payload, 400 for bad JSON, 413 for oversized body", { skip }, async () => {
    const auth = { Authorization: `Bearer ${key}` };
    assert.equal((await post({ email: "no-name@example.com" }, auth)).status, 422);
    assert.equal((await post("{not json", auth, true)).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x", notes: "n".repeat(20_000) }), auth, true)).status, 413);
  });

  it("never echoes the key or internal errors in responses", { skip }, async () => {
    const res = await post({ name: "x" }, { Authorization: "Bearer fcrm_" + "z".repeat(43) });
    const text = await res.text();
    assert.ok(!text.includes("zzzz"));
    assert.ok(!/stack|sql|postgres/i.test(text));
  });
});
