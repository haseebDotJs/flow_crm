/**
 * End-to-end check of the voice pipeline without a microphone.
 * Joins a real LiveKit room as the demo user (same token shape as /api/livekit/token),
 * sends the acceptance sentence as text, waits for the agent's spoken reply, then verifies
 * the database. Requires `npm run agent:dev` to be running.
 *
 * Usage: npm run e2e:voice
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { Room } from "@livekit/rtc-node";

config({ path: ".env.local", quiet: true });

const TZ = "Europe/Warsaw";
const EXPECT_HOUR = Number(process.argv[3] ?? 10); // 9 when the phrase names no time
const FOLLOWUP = process.argv[4]; // optional 2nd user message, sent after the agent's first reply
const PHRASE = process.argv[2] ?? "Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM.";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, opts);
  const { data: auth, error } = await db.auth.signInWithPassword({
    email: "demo@flowcrm.test",
    password: "FlowCRM-demo-2026",
  });
  assert.equal(error, null);
  const user = auth.user!;

  // Reset scenario: John's deal in New, no test follow-ups.
  const { data: opp } = await db.from("opportunities").select("id").eq("title", "Acme Enterprise License").single();
  await db.from("opportunities").update({ stage: "new" }).eq("id", opp!.id);
  await db.from("tasks").delete().eq("opportunity_id", opp!.id);

  const token = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: user.id,
    name: "Demo User",
    ttl: "10m",
    metadata: JSON.stringify({ supabaseAccessToken: auth.session!.access_token, timeZone: TZ, userName: "Demo User" }),
  });
  const roomName = `e2e-${randomUUID().slice(0, 8)}`;
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: "flowcrm-agent" })] });

  const room = new Room();
  const replies: string[] = [];
  room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
    if (info.identity === user.id) return;
    const text = (await reader.readAll()).trim();
    if (text) {
      replies.push(text);
      console.log(`[agent] ${text}`);
    }
  });

  await room.connect(process.env.LIVEKIT_URL!, await token.toJwt());
  console.log("joined room", roomName);

  // Wait for the agent to join and greet.
  const waitFor = async (pred: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  await waitFor(() => replies.length >= 1, 45_000, "agent greeting");

  console.log(`[user] ${PHRASE}`);
  const before = replies.length;
  await room.localParticipant!.sendText(PHRASE, { topic: "lk.chat" });
  await waitFor(() => replies.length > before, 60_000, "agent reply");
  await new Promise((r) => setTimeout(r, 4000)); // let any follow-up sentences arrive

  if (FOLLOWUP) {
    const mid = replies.length;
    console.log(`[user] ${FOLLOWUP}`);
    await room.localParticipant!.sendText(FOLLOWUP, { topic: "lk.chat" });
    await waitFor(() => replies.length > mid, 60_000, "agent reply to follow-up");
    await new Promise((r) => setTimeout(r, 4000));
  }

  await room.disconnect();

  const { data: after } = await db.from("opportunities").select("stage").eq("id", opp!.id).single();
  const { data: tasks } = await db
    .from("tasks")
    .select("title, due_at, status, contact_id, opportunity_id")
    .eq("opportunity_id", opp!.id);
  console.log("DB stage:", after?.stage);
  console.log("DB tasks:", JSON.stringify(tasks));

  assert.equal(after?.stage, "qualified", "opportunity should be Qualified");
  assert.equal(tasks?.length, 1, "exactly one follow-up should exist");
  const due = new Date(tasks![0].due_at);
  const localHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(due),
  );
  assert.equal(localHour, EXPECT_HOUR, `follow-up should be at ${EXPECT_HOUR}:00 local time`);
  const tomorrow = new Date(Date.now() + 86_400_000);
  const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  assert.equal(ymd(due), ymd(tomorrow), "follow-up should be tomorrow");
  // The assistant's changes must be attributed to the Voice AI in the activity log.
  const { data: logs } = await db
    .from("activity_log")
    .select("action, summary, actor")
    .eq("entity_id", opp!.id)
    .order("created_at", { ascending: true });
  console.log("Activity:", JSON.stringify(logs));
  const stage = logs?.filter((l) => l.action === "stage_changed").at(-1);
  assert.equal(stage?.actor, "voice", "stage change should be attributed to voice");

  console.log("E2E PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("E2E FAIL:", e.message ?? e);
  process.exit(1);
});
