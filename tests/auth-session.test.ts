/**
 * A revoked session (password reset, sign-out everywhere, deleted user) whose JWT has not
 * expired yet must never cause a redirect loop: the user should land on the login page.
 * Needs the web app running (npm run dev); skipped otherwise.
 * Usage: npm run test:auth-session
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, opts);
let userId = "";
let cookie = "";
let accessToken = "";

/** Follows redirects by hand (with the given cookies) and reports the path taken. */
async function follow(path: string, maxHops = 8) {
  const hops: string[] = [];
  let current = path;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(`${BASE}${current}`, { headers: { Cookie: cookie }, redirect: "manual" });
    hops.push(`${current} -> ${res.status}`);
    if (res.status >= 300 && res.status < 400) {
      current = new URL(res.headers.get("location")!, BASE).pathname;
      continue;
    }
    return { final: current, status: res.status, hops, looped: false };
  }
  return { final: current, status: 0, hops, looped: true };
}

async function prepareSession() {
  const email = `session-${Date.now()}@flowcrm.test`;
  const password = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  userId = created.data.user!.id;

  const db = createClient(url, publishable, opts);
  const { data } = await db.auth.signInWithPassword({ email, password });
  accessToken = data.session!.access_token;

  // @supabase/ssr cookie format: base64url(JSON session), chunked.
  const ref = new URL(url).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64url");
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += 3180, n++) parts.push(`sb-${ref}-auth-token.${n}=${value.slice(i, i + 3180)}`);
  cookie = parts.join("; ");
}

async function cleanup() {
  if (userId) await admin.auth.admin.deleteUser(userId);
}

describe("session handling in the proxy", async () => {
  let up = true;
  try {
    await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    up = false;
  }
  const skip = up ? false : `web app not running at ${BASE}`;
  before(up ? prepareSession : async () => {});
  after(cleanup);

  it("a valid session reaches the dashboard and is redirected away from /login", { skip }, async () => {
    const dash = await follow("/dashboard");
    assert.equal(dash.final, "/dashboard", dash.hops.join(", "));
    assert.equal(dash.status, 200);
    const login = await follow("/login");
    assert.equal(login.final, "/dashboard", login.hops.join(", "));
  });

  it("no cookies: protected pages go to /login", { skip }, async () => {
    const saved = cookie;
    cookie = "";
    const r = await follow("/dashboard");
    cookie = saved;
    assert.equal(r.final, "/login");
    assert.equal(r.status, 200);
  });

  it("a REVOKED session (JWT still unexpired) lands on /login, never in a redirect loop", { skip }, async () => {
    await admin.auth.admin.signOut(accessToken, "global"); // revoke every session of this user

    for (const start of ["/dashboard", "/login", "/", "/tasks"]) {
      const r = await follow(start);
      assert.equal(r.looped, false, `loop starting at ${start}: ${r.hops.join(", ")}`);
      assert.equal(r.final, "/login", `from ${start}: ${r.hops.join(", ")}`);
      assert.equal(r.status, 200);
    }
  });

  it("a deleted user's leftover session also lands on /login", { skip }, async () => {
    await admin.auth.admin.deleteUser(userId);
    userId = "";
    const r = await follow("/dashboard");
    assert.equal(r.looped, false, r.hops.join(", "));
    assert.equal(r.final, "/login");
  });
});
