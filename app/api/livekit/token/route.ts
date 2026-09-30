import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { createClient } from "@/lib/supabase/server";

// Must match AGENT_NAME in agent/index.ts.
const AGENT_NAME = "flowcrm-agent";

export const dynamic = "force-dynamic";

/**
 * Mints a short-lived LiveKit token for the signed-in user and dispatches the voice agent
 * into a fresh per-session room. The token is signed with LIVEKIT_API_SECRET, so the agent
 * can trust the identity (Supabase user id) and metadata it carries.
 */
export async function POST(request: Request) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "Voice assistant is not configured." }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser(); // verified with Supabase Auth
  const user = userData.user;
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return NextResponse.json({ error: "No active session." }, { status: 401 });

  let timeZone = "UTC";
  try {
    const body = (await request.json()) as { timeZone?: unknown };
    if (typeof body.timeZone === "string") {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone }); // throws if invalid
      timeZone = body.timeZone;
    }
  } catch {
    /* fall back to UTC */
  }

  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const name = profile?.full_name || user.email || "User";

  const roomName = `crm-${user.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: user.id,
    name,
    ttl: "15m",
    metadata: JSON.stringify({ supabaseAccessToken: accessToken, timeZone, userName: name }),
  });
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })] });

  return NextResponse.json(
    { serverUrl: LIVEKIT_URL, token: await token.toJwt(), roomName },
    { headers: { "Cache-Control": "no-store" } },
  );
}
