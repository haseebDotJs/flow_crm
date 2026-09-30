import { fileURLToPath } from "node:url";
import {
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
  type JobContext,
  type JobProcess,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { isValidTimeZone } from "./datetime";
import { buildInstructions } from "./prompt";
import { buildCrmTools } from "./tools";

config({ path: ".env.local", quiet: true });

export const AGENT_NAME = "flowcrm-agent";

interface ParticipantMeta {
  supabaseAccessToken?: string;
  timeZone?: string;
  userName?: string;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    // The web app mints this LiveKit token after verifying the Supabase session, so the
    // identity and metadata are signed with our LiveKit secret and can be trusted.
    let meta: ParticipantMeta = {};
    try {
      meta = JSON.parse(participant.metadata || "{}");
    } catch {
      /* handled below */
    }
    const accessToken = meta.supabaseAccessToken;
    if (!accessToken) {
      console.error("No Supabase access token on participant; shutting down.");
      ctx.shutdown("unauthenticated");
      return;
    }

    // Everything the agent does runs as the user: Postgres RLS applies to every query.
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        // `x-flowcrm-actor` lets the activity log label these changes as made by voice.
        global: { headers: { Authorization: `Bearer ${accessToken}`, "x-flowcrm-actor": "voice" } },
      },
    );
    const { data, error } = await db.auth.getUser(accessToken);
    if (error || !data.user || data.user.id !== participant.identity) {
      console.error("Supabase token does not match the LiveKit participant; shutting down.");
      ctx.shutdown("identity_mismatch");
      return;
    }
    const userId = data.user.id;

    const timeZone = meta.timeZone && isValidTimeZone(meta.timeZone) ? meta.timeZone : "UTC";
    const userName = meta.userName?.slice(0, 80) || "the user";

    const agent = voice.Agent.create({
      instructions: buildInstructions(userName, timeZone),
      tools: buildCrmTools({ db, userId, timeZone }),
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: "deepgram/nova-3", language: "en" }),
      llm: new inference.LLM({ model: "openai/gpt-4.1-mini" }),
      tts: new inference.TTS({
        model: "cartesia/sonic-3",
        voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
      }),
    });

    await session.start({ agent, room: ctx.room });
    await session.generateReply({
      instructions: `Greet ${userName} in one short sentence and ask what they'd like to do in their CRM.`,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
