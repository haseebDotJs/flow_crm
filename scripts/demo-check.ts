/**
 * Pre-flight check before a demo / recording.
 *
 *   npm run demo:check             checks config, database, scheduler, email and LiveKit
 *   npm run demo:check -- --agent  also joins a voice room and waits for the agent's greeting
 *                                  (needs `npm run agent:dev` running; changes no CRM data)
 *
 * It never sends an email and never prints a secret.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from "livekit-server-sdk";

config({ path: ".env.local", quiet: true });

// The LiveKit realtime library logs at debug level unless NODE_ENV=production; keep the output readable.
(process.env as Record<string, string>).NODE_ENV = "production";

const WITH_AGENT = process.argv.includes("--agent");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const DEMO_EMAIL = "demo@flowcrm.test";
const DEMO_PASSWORD = "FlowCRM-demo-2026";
const env = (k: string) => (process.env[k] ?? "").trim();

let failures = 0;
let warnings = 0;
const ok = (msg: string) => console.log(`  [ ok ] ${msg}`);
const bad = (msg: string, fix: string) => {
  failures++;
  console.log(`  [FAIL] ${msg}\n         -> ${fix}`);
};
const warn = (msg: string, fix: string) => {
  warnings++;
  console.log(`  [warn] ${msg}\n         -> ${fix}`);
};
const section = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("FlowCRM demo pre-flight\n=======================");

  // ---------------------------------------------------------------- environment
  section("1. Environment");
  const major = Number(process.versions.node.split(".")[0]);
  major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, "Install Node 22+ (nvm use 22)");

  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
  ];
  const missing = required.filter((k) => !env(k));
  missing.length === 0 ? ok("Supabase and LiveKit variables are set") : bad(`Missing in .env.local: ${missing.join(", ")}`, "Fill them in (see .env.example)");
  if (env("LIVEKIT_URL") && !env("LIVEKIT_URL").startsWith("wss://")) bad("LIVEKIT_URL must start with wss://", "Prefix it with wss://");
  env("RESEND_API_KEY") ? ok("RESEND_API_KEY is set") : warn("RESEND_API_KEY not set", "Add it and run npm run email:setup (needed for real emails)");
  env("EMAIL_TEST_RECIPIENT")
    ? ok("EMAIL_TEST_RECIPIENT is set")
    : warn("EMAIL_TEST_RECIPIENT not set", "Set it to your Resend account email, then npm run seed");
  ["true", "1", "yes", "on"].includes(env("DEMO").toLowerCase())
    ? ok("DEMO=true (30-second scheduled emails)")
    : warn("DEMO is not true", "Set DEMO=true to show the scheduler in ~40 s (otherwise follow-ups are due in 2 days)");

  if (missing.length > 0) return summary();
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };

  // ------------------------------------------------------------------- database
  section("2. Supabase");
  const db = createClient(url, env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), opts);
  const admin = createClient(url, env("SUPABASE_SECRET_KEY"), opts);

  const { data: auth, error: authError } = await db.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (authError || !auth.user) {
    bad(`Demo login failed (${authError?.message ?? "no user"})`, "Run: npm run seed");
    return summary();
  }
  ok(`Demo user can log in (${DEMO_EMAIL})`);
  const uid = auth.user.id;

  const { data: opp } = await db.from("opportunities").select("id, stage, title").eq("title", "Acme Enterprise License").maybeSingle();
  if (!opp) bad("Demo deal 'Acme Enterprise License' not found", "Run: npm run seed");
  else if (opp.stage !== "new") bad(`John Smith's deal is in '${opp.stage}', not 'new'`, "Run: npm run seed (resets the demo data)");
  else ok("John Smith's deal is in New");

  if (opp) {
    const { data: tasks } = await db.from("tasks").select("id").eq("opportunity_id", opp.id).eq("status", "pending");
    (tasks?.length ?? 0) === 0 ? ok("No pending follow-ups on John's deal") : bad(`${tasks!.length} pending follow-up(s) already on John's deal`, "Run: npm run seed");
  }

  const { count: contacts } = await db.from("contacts").select("id", { count: "exact", head: true });
  contacts === 4 ? ok("4 demo contacts") : warn(`${contacts} contacts (expected 4)`, "Run: npm run seed for a clean demo");

  const { data: john } = await db.from("contacts").select("email").eq("name", "John Smith").maybeSingle();
  john?.email ? ok("John Smith has an email address (needed for the email demo)") : bad("John Smith has no email address", "Run: npm run seed");

  const { count: templates } = await db.from("email_templates").select("id", { count: "exact", head: true });
  (templates ?? 0) >= 3 ? ok(`${templates} email templates`) : bad(`Only ${templates} email templates`, "Run: npm run seed");

  const { data: prof } = await db.from("profiles").select("role, email_test_mode, email_test_recipient").eq("id", uid).single();
  prof?.email_test_mode ? ok("Email test mode is ON (emails go to your inbox, not to contacts)") : warn("Email test mode is OFF: emails would go to real contact addresses", "Turn it on in Email > Sending, or run npm run seed");
  prof?.email_test_recipient ? ok("Test recipient is set") : bad("No test recipient set (Resend's sandbox will reject the email)", "Set EMAIL_TEST_RECIPIENT and run npm run seed");

  const { count: logs } = await db.from("activity_log").select("id", { count: "exact", head: true });
  (logs ?? 0) === 0 ? ok("Activity log is empty (clean start)") : warn(`Activity log has ${logs} entries`, "Run npm run seed for a clean start");

  const { data: hook } = await db.from("webhook_endpoints").select("url").maybeSingle();
  hook ? warn("An outbound webhook is already configured", "Fine if intended; otherwise npm run seed clears it") : ok("No outbound webhook yet (you'll add your webhook.site URL live)");

  // ---------------------------------------------------------- scheduler + email
  section("3. Scheduler and email");
  const { data: status } = await admin.rpc("automation_status");
  status?.scheduler_active ? ok(`Scheduler is running (${status.scheduler_schedule})`) : bad("Scheduler job is not running", "Re-run migrations: npx supabase db push");
  status?.provider_configured ? ok("Email provider key is stored in Vault") : bad("Email provider key is not stored", "Run: npm run email:setup");
  if (status?.demo_mode) ok("Demo mode is ON in the database (Qualified follow-ups due in 30 s)");
  else warn("Demo mode is OFF in the database", "Set DEMO=true and run npm run demo:apply");
  if (status?.demo_mode && status.scheduler_schedule !== "10 seconds") warn(`Scheduler schedule is '${status.scheduler_schedule}'`, "Run npm run demo:apply");

  // -------------------------------------------------------------------- LiveKit
  section("4. LiveKit");
  try {
    const host = env("LIVEKIT_URL").replace("wss://", "https://");
    const rooms = new RoomServiceClient(host, env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"));
    await rooms.listRooms();
    ok("LiveKit credentials are valid");
  } catch (e) {
    bad(`LiveKit rejected the credentials (${(e as Error).message})`, "Check LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET");
  }

  // ------------------------------------------------------------------ web app
  section("5. Web app");
  try {
    const res = await fetch(`${APP_URL}/login`, { signal: AbortSignal.timeout(30_000) });
    res.ok ? ok(`Web app is up at ${APP_URL}`) : bad(`Web app returned ${res.status}`, "Restart: npm run dev");
  } catch {
    bad(`Web app is not reachable at ${APP_URL}`, "Start it: npm run dev");
  }

  // ---------------------------------------------------------------------- agent
  section("6. Voice agent");
  if (!WITH_AGENT) {
    console.log("  [ -- ] skipped. Run `npm run demo:check -- --agent` with `npm run agent:dev` running to verify it end to end.");
  } else {
    await checkAgent(auth.session!.access_token, uid);
  }

  summary();
}

/** Joins a voice room as the demo user and waits for the agent's greeting. Changes no CRM data. */
async function checkAgent(accessToken: string, uid: string) {
  const token = new AccessToken(env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"), {
    identity: uid,
    name: "Demo User",
    ttl: "5m",
    metadata: JSON.stringify({ supabaseAccessToken: accessToken, timeZone: "UTC", userName: "Demo User" }),
  });
  token.addGrant({ room: `check-${randomUUID().slice(0, 8)}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: "flowcrm-agent" })] });

  const { Room } = await import("@livekit/rtc-node"); // loaded after NODE_ENV is set, so it stays quiet
  const room = new Room();
  let greeting = "";
  room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
    if (info.identity === uid) return;
    const text = (await reader.readAll()).trim();
    if (text && !greeting) greeting = text;
  });
  try {
    await room.connect(env("LIVEKIT_URL"), await token.toJwt());
    const started = Date.now();
    while (!greeting && Date.now() - started < 45_000) await sleep(500);
    greeting
      ? ok(`Agent joined and spoke in ${((Date.now() - started) / 1000).toFixed(1)} s: "${greeting}"`)
      : bad("The agent did not respond within 45 s", "Start it with: npm run agent:dev (keep only ONE agent running)");
  } catch (e) {
    bad(`Could not join a LiveKit room (${(e as Error).message})`, "Check the LiveKit credentials");
  } finally {
    await room.disconnect().catch(() => {});
  }
}

function summary() {
  console.log("\n=======================");
  if (failures === 0) {
    console.log(warnings === 0 ? "READY: everything checks out." : `READY, with ${warnings} warning(s) to glance at.`);
  } else {
    console.log(`NOT READY: ${failures} problem(s) to fix (see -> lines above).`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Pre-flight crashed:", e.message ?? e);
  process.exit(1);
});
