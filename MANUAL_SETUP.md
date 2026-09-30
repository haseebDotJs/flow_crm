# FlowCRM — Manual Setup Checklist

Steps only you can do (accounts, credentials, dashboard toggles). Never paste secrets into chat, commits, or `NEXT_PUBLIC_*` variables. Put them in `.env.local` (git-ignored), which I will create from `.env.example`.

Decisions already made:
- Voice agent: **Node/TypeScript** (`@livekit/agents`)
- Agent data access: **user's Supabase JWT** (RLS enforced, no service-role key in the agent)

---

## 0. Prerequisites

- [ ] Node **22.12.0** active: run `node -v` in the terminal Claude Code uses (open a new terminal after `nvm use 22.12.0`).
- [ ] `npm -v` works (bundled with Node).
- [ ] Git installed (already present).
- [ ] Docker is **not** needed.

## 1. Supabase project

1. Go to https://supabase.com/dashboard and create a new project (any name, e.g. `flowcrm`; pick the region nearest you).
2. **Save the database password** somewhere safe. It is needed for `supabase link` / `db push`.
3. Wait for provisioning to finish.

### Credentials to collect

| Value | Where to find it | Goes into |
|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | Project Settings → API (or Connect button) | `NEXT_PUBLIC_SUPABASE_URL` |
| Publishable key (`sb_publishable_…`) | Project Settings → API Keys | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key (`sb_secret_…`) | Project Settings → API Keys | `SUPABASE_SECRET_KEY` — **seed script only**, never the browser or the agent |
| Project ref = "Project ID" in the dashboard (the `<ref>` in the URL): `gitretnywhxsgaeysneb` | Project Settings → General | Used by me for `supabase link --project-ref` |
| Database password | Set in step 2 above | Typed into the CLI prompt; not stored in files |

If the dashboard only shows legacy `anon` / `service_role` keys, tell me. They work in the same variables.

### Auth settings

- [ ] Authentication → Providers → **Email** enabled (default).
- [ ] Authentication → Sign In / Providers (or Settings) → **turn off "Confirm email"** so demo signups work without SMTP.
- [ ] Authentication → URL Configuration → Site URL: `http://localhost:3000`. Add `http://localhost:3000/**` to Redirect URLs.

### CLI login (run in your own terminal)

```bash
npx supabase login
```

This opens a browser to authorize the CLI. Afterwards I can run `supabase link` and `supabase db push` (you'll be asked for the DB password once).

## 2. LiveKit Cloud project

1. Go to https://cloud.livekit.io and sign up / sign in.
2. Create a new project (e.g. `flowcrm`).

### Credentials to collect

| Value | Where to find it | Goes into |
|---|---|---|
| WebSocket URL (`wss://<project>.livekit.cloud`) | Project Settings (or the dashboard header) | `LIVEKIT_URL` |
| API Key | Settings → Keys → create/copy | `LIVEKIT_API_KEY` |
| API Secret | Shown once when the key is created | `LIVEKIT_API_SECRET` |

- [ ] Confirm **LiveKit Inference** (LLM + STT + TTS) is available on your plan. Check the Models / Inference section of the dashboard and note any quota limits.
- [ ] If Inference is **not** available, tell me. I will switch to provider plugins and you'll need extra keys (e.g. OpenAI, Deepgram), which I'll add to `.env.example` at that point.

## 3. Create `.env.local` (after I scaffold the project)

I'll generate `.env.example`. You then copy it and fill in the values:

```bash
cp .env.example .env.local
```

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=        # seed script only

LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

The agent reads the same LiveKit variables plus the Supabase URL and publishable key.

## 4. Browser / hardware

- [ ] Use Chrome or Edge on `http://localhost:3000` (localhost counts as a secure context, so mic access works).
- [ ] Working microphone and speakers/headphones. **Use headphones** to avoid the agent hearing itself.
- [ ] Allow the microphone when the browser prompts.

## 5. What to send me when done

Do **not** paste secrets. Just confirm:

- [ ] "Supabase project created, `npx supabase login` done, project ref is `<ref>`" (the ref is not secret).
- [ ] "`.env.local` filled in."
- [ ] "LiveKit project created. Inference is available / not available."

## 6. Later runtime checks (I'll guide you)

- [ ] `npx supabase db push` succeeds (needs the DB password).
- [ ] Seed script run (needs `SUPABASE_SECRET_KEY`).
- [ ] `npm run dev` (web) and the agent worker running in two terminals.
- [ ] Acceptance test: log in as the demo user and say *"Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM."*
