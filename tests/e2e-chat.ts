/**
 * Multi-turn conversation with the real voice agent (text input, no microphone).
 * Joins a LiveKit room as the demo user, sends each message in order, waits for the agent's
 * reply after each, then prints John Smith's deal and its tasks. Requires `npm run agent:dev`.
 *
 * Usage: npx tsx tests/e2e-chat.ts "message 1" "message 2" ...
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { Room } from "@livekit/rtc-node";

config({ path: ".env.local", quiet: true });

const TZ = "Europe/Warsaw";
const messages = process.argv.slice(2);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, opts);
  const { data: auth, error } = await db.auth.signInWithPassword({ email: "demo@flowcrm.test", password: "FlowCRM-demo-2026" });
  if (error) throw error;
  const user = auth.user!;

  // Reset the scenario: John's deal in New, no tasks.
  const { data: opp } = await db.from("opportunities").select("id").eq("title", "Acme Enterprise License").single();
  await db.from("tasks").delete().eq("opportunity_id", opp!.id);
  await db.from("opportunities").update({ stage: "new" }).eq("id", opp!.id);

  const token = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: user.id,
    name: "Demo User",
    ttl: "10m",
    metadata: JSON.stringify({ supabaseAccessToken: auth.session!.access_token, timeZone: TZ, userName: "Demo User" }),
  });
  const roomName = `chat-${randomUUID().slice(0, 8)}`;
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: "flowcrm-agent" })] });

  const room = new Room();
  const replies: string[] = [];
  room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
    if (info.identity === user.id) return;
    const text = (await reader.readAll()).trim();
    if (text) {
      replies.push(text);
      console.log(`  [agent] ${text}`);
    }
  });

  await room.connect(process.env.LIVEKIT_URL!, await token.toJwt());
  console.log("room:", roomName);

  const waitFor = async (pred: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(500);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  await waitFor(() => replies.length >= 1, 45_000, "greeting");

  for (const m of messages) {
    console.log(`[user] ${m}`);
    const before = replies.length;
    await room.localParticipant!.sendText(m, { topic: "lk.chat" });
    await waitFor(() => replies.length > before, 60_000, "agent reply");
    await sleep(5000); // let tool calls + any further sentences finish
  }
  await room.disconnect();

  const { data: deal } = await db.from("opportunities").select("stage").eq("id", opp!.id).single();
  const { data: tasks } = await db
    .from("tasks")
    .select("title, status, source, due_at")
    .eq("opportunity_id", opp!.id)
    .order("created_at");
  const local = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: TZ, hour12: false });
  console.log(`DEAL STAGE: ${deal?.stage}`);
  console.log(`TASKS (${tasks?.length}):`);
  for (const t of tasks ?? []) console.log(`  - ${t.status.padEnd(9)} ${t.source.padEnd(10)} ${local(t.due_at)}  ${t.title}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
