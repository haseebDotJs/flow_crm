"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useTranscriptions,
  useVoiceAssistant,
  type TextStreamData,
} from "@livekit/components-react";
import { Loader2, Mic, MicOff, PhoneOff, Volume2, X, AlertTriangle, Brain } from "lucide-react";
import { cn } from "@/lib/utils";

type UiState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "error";

interface Connection {
  serverUrl: string;
  token: string;
}

const AGENT_JOIN_TIMEOUT_MS = 25_000;

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * Turns raw transcription streams into chat messages.
 * - Streams that share a segment id are one utterance (keep the latest text).
 * - Consecutive segments from the same speaker are merged into one message, because speech
 *   recognition emits several segments for a single spoken turn.
 */
function buildMessages(streams: TextStreamData[], agentIdentity: string | undefined): Message[] {
  const segments = new Map<string, { id: string; role: Message["role"]; text: string; ts: number }>();
  for (const s of streams) {
    const text = s.text.trim();
    if (!text) continue;
    const attrs = s.streamInfo.attributes ?? {};
    const key = attrs["lk.segment_id"] ?? s.streamInfo.id;
    const prev = segments.get(key);
    segments.set(key, {
      id: key,
      role: s.participantInfo.identity === agentIdentity ? "assistant" : "user",
      text,
      ts: prev?.ts ?? s.streamInfo.timestamp,
    });
  }

  const merged: Message[] = [];
  for (const seg of [...segments.values()].sort((a, b) => a.ts - b.ts)) {
    const last = merged[merged.length - 1];
    if (last && last.role === seg.role) last.text = `${last.text} ${seg.text}`;
    else merged.push({ id: seg.id, role: seg.role, text: seg.text });
  }
  return merged;
}

export function VoiceAssistant() {
  const [open, setOpen] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Full conversation: finished sessions live in `history`, the current one in `liveRef`.
  const [history, setHistory] = useState<Message[]>([]);
  const liveRef = useRef<Message[]>([]);

  const archive = useCallback(() => {
    const live = liveRef.current;
    if (live.length === 0) return;
    liveRef.current = [];
    setHistory((h) => [...h, ...live]);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start the voice assistant.");
      setConn({ serverUrl: json.serverUrl, token: json.token });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the voice assistant.");
      setConnecting(false);
    }
  }, []);

  const stop = useCallback(() => {
    archive();
    setConn(null);
    setConnecting(false);
  }, [archive]);

  const fail = useCallback((message: string) => {
    // Keep the first (root-cause) error; teardown can raise follow-up disconnect errors.
    setError((prev) => prev ?? message);
    archive();
    setConn(null);
    setConnecting(false);
  }, [archive]);

  const active = !!conn;
  const idleState: UiState = error ? "error" : connecting ? "connecting" : "idle";

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-5 py-3 text-sm font-medium text-white shadow-lg hover:bg-indigo-700"
        >
          <Mic className="h-4 w-4" /> Talk to your CRM
        </button>
      )}

      {open && (
        <section
          aria-label="Voice assistant"
          className="card fixed bottom-5 right-5 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden"
        >
          <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold">Voice assistant</h2>
            <button
              type="button"
              aria-label="Close voice assistant"
              className="text-slate-400 hover:text-slate-600"
              onClick={() => {
                stop();
                setOpen(false);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {active ? (
            <LiveKitRoom
              serverUrl={conn.serverUrl}
              token={conn.token}
              connect
              audio
              video={false}
              onDisconnected={stop}
              onError={(e) => fail(e.message || "Connection error.")}
              onMediaDeviceFailure={() =>
                fail("Microphone unavailable. Allow microphone access in your browser and try again.")
              }
            >
              <RoomAudioRenderer />
              <ActiveSession
                history={history}
                liveRef={liveRef}
                onFail={fail}
                onStop={stop}
                onConnected={() => setConnecting(false)}
              />
            </LiveKitRoom>
          ) : (
            <IdlePanel state={idleState} error={error} history={history} onStart={start} />
          )}
        </section>
      )}
    </>
  );
}

function StatusBadge({ state, micOn }: { state: UiState; micOn?: boolean }) {
  const map: Record<UiState, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: "Idle", cls: "bg-slate-100 text-slate-600", icon: <MicOff className="h-4 w-4" /> },
    connecting: { label: "Connecting…", cls: "bg-amber-50 text-amber-700", icon: <Loader2 className="h-4 w-4 animate-spin" /> },
    listening: { label: "Listening…", cls: "bg-emerald-50 text-emerald-700", icon: <Mic className="h-4 w-4" /> },
    processing: { label: "Processing…", cls: "bg-indigo-50 text-indigo-700", icon: <Brain className="h-4 w-4 animate-pulse" /> },
    speaking: { label: "Speaking…", cls: "bg-sky-50 text-sky-700", icon: <Volume2 className="h-4 w-4" /> },
    error: { label: "Error", cls: "bg-red-50 text-red-700", icon: <AlertTriangle className="h-4 w-4" /> },
  };
  const s = map[state];
  return (
    <div className="flex items-center justify-between">
      <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium", s.cls)} aria-live="polite">
        {s.icon} {s.label}
      </span>
      {micOn !== undefined && (
        <span className={cn("text-xs", micOn ? "text-emerald-600" : "text-slate-400")}>
          {micOn ? "● Microphone on" : "○ Microphone off"}
        </span>
      )}
    </div>
  );
}

function Transcript({ messages, empty }: { messages: Message[]; empty?: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  if (messages.length === 0) return empty ? <p className="text-sm text-slate-400">{empty}</p> : null;
  return (
    <ul ref={listRef} className="max-h-72 space-y-2 overflow-y-auto pr-1 text-sm" aria-label="Transcript">
      {messages.map((m) => (
        <li
          key={m.id}
          className={cn("rounded-lg px-3 py-2", m.role === "assistant" ? "bg-slate-100" : "bg-indigo-50 text-indigo-900")}
        >
          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
            {m.role === "assistant" ? "Assistant" : "You"}
          </span>
          {m.text}
        </li>
      ))}
    </ul>
  );
}

function IdlePanel({
  state,
  error,
  history,
  onStart,
}: {
  state: UiState;
  error: string | null;
  history: Message[];
  onStart: () => void;
}) {
  const busy = state === "connecting";
  return (
    <div className="space-y-4 p-4">
      <StatusBadge state={state} micOn={false} />
      {error ? (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-slate-500">
          Try: &ldquo;Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM.&rdquo;
        </p>
      ) : null}
      <Transcript messages={history} />
      <button type="button" className="btn-primary w-full" disabled={busy} onClick={onStart}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
        {error ? "Try again" : "Talk to your CRM"}
      </button>
    </div>
  );
}

function ActiveSession({
  history,
  liveRef,
  onFail,
  onStop,
  onConnected,
}: {
  history: Message[];
  liveRef: React.MutableRefObject<Message[]>;
  onFail: (message: string) => void;
  onStop: () => void;
  onConnected: () => void;
}) {
  const { state: agentState, agent } = useVoiceAssistant();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const transcriptions = useTranscriptions();

  const live = useMemo(() => buildMessages(transcriptions, agent?.identity), [transcriptions, agent?.identity]);
  // Expose the current session's messages so the parent can archive them when it ends.
  useEffect(() => {
    liveRef.current = live;
  }, [live, liveRef]);

  const ui: UiState =
    agentState === "speaking"
      ? "speaking"
      : agentState === "thinking"
        ? "processing"
        : agentState === "listening"
          ? "listening"
          : agentState === "failed"
            ? "error"
            : "connecting";

  // Give up if the agent worker never joins (e.g. it isn't running).
  const joined = ui !== "connecting";
  useEffect(() => {
    if (joined) {
      onConnected();
      return;
    }
    const t = setTimeout(
      () => onFail("The voice agent didn't respond. Make sure it is running (npm run agent:dev)."),
      AGENT_JOIN_TIMEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [joined, onFail, onConnected]);

  const all = useMemo(() => [...history, ...live], [history, live]);

  return (
    <div className="space-y-3 p-4">
      <StatusBadge state={ui} micOn={isMicrophoneEnabled} />
      <Transcript messages={all} empty="Say something…" />
      <button type="button" className="btn-danger w-full" onClick={onStop}>
        <PhoneOff className="h-4 w-4" /> End conversation
      </button>
    </div>
  );
}
