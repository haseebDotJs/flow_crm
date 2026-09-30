# FlowCRM

A small, polished sales CRM with one excellent workflow: talk to it.

> "Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM."

FlowCRM understands that, finds the records, updates the pipeline, schedules the follow-up, and the UI updates live.

## Features

- Email/password authentication (Supabase Auth) with protected routes
- Dashboard: contact and opportunity counts, open pipeline value, stage summary, upcoming follow-ups
- Contacts: list, search, create, edit, detail view with related opportunities and tasks
- Opportunities and pipeline: Kanban columns (New → Lost) with a stage dropdown, opportunity detail page
- Follow-up tasks: create, complete, cancel; grouped as overdue / today / tomorrow / upcoming
- Realtime Voice AI assistant (LiveKit Agents + LiveKit Inference) with four structured CRM tools
- Live UI updates when the assistant changes data (Supabase Realtime)
- Workflow automation: moving an opportunity from New to Qualified automatically creates a "Follow up with <contact>" task two days out (marked "Auto")
- Row Level Security on every CRM table; reproducible SQL migrations and seed data

## Architecture

```text
Next.js (App Router)
   ↓
Supabase Auth / PostgreSQL / RLS
```

```text
Browser (mic)  ──►  LiveKit Cloud  ◄──►  Voice Agent (Node, agent/)
                                              ↓
                                   CRM tools (validated, per-user)
                                              ↓
                                     Supabase (RLS as the user)
```

- `app/`, `components/`, `lib/`: the Next.js web app (server components + server actions).
- `app/api/livekit/token`: verifies the Supabase session, mints a short-lived LiveKit token (identity = Supabase user id) and dispatches the agent into a fresh room.
- `agent/`: the LiveKit voice agent. It is a separate process from the web app.
- `supabase/migrations`: schema, constraints, indexes, RLS, triggers. `supabase/seed`: demo data.

## Requirements

- Node.js 22.12 or newer (`.nvmrc` is provided)
- A Supabase project and a LiveKit Cloud project (both have free tiers)
- No Docker and no local database

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Create a Supabase project** at https://supabase.com/dashboard.
   In Authentication → Sign In / Providers → Email, turn off **Confirm email** for the demo.
3. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Fill in the Supabase values (Project Settings → API / API Keys).
4. **Run migrations** (you will be asked for the database password on `link`)
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-id>
   npx supabase db push
   ```
5. **Seed demo data** (creates `demo@flowcrm.test`; the demo password is in `supabase/seed/seed.ts`)
   ```bash
   npm run seed
   ```
6. **Create a LiveKit Cloud project** at https://cloud.livekit.io.
7. **Configure LiveKit credentials** in `.env.local` (`LIVEKIT_URL` must start with `wss://`).
   The agent uses LiveKit Inference (speech-to-text, LLM, text-to-speech) billed through your LiveKit project, so no separate AI provider keys are needed.
8. **Start the web app**
   ```bash
   npm run dev
   ```
9. **Start the voice agent** in a second terminal
   ```bash
   npm run agent:dev
   ```

Open http://localhost:3000, log in with the demo user, click **Talk to your CRM**, allow the microphone, and say the sentence above.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web, agent, seed | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | web, agent | Publishable (anon) key. Safe for browsers; data access is governed by RLS |
| `SUPABASE_SECRET_KEY` | seed script only | Secret key that bypasses RLS. Used only to create the demo user and data. Never used by the web app or agent |
| `LIVEKIT_URL` | web (server), agent | LiveKit Cloud WebSocket URL, `wss://…` |
| `LIVEKIT_API_KEY` | web (server), agent | LiveKit API key |
| `LIVEKIT_API_SECRET` | web (server), agent | LiveKit API secret |
| `SUPABASE_DB_PASSWORD` | Supabase CLI (optional) | Lets `supabase link` / `db push` run without prompting |

None of the secrets use the `NEXT_PUBLIC_` prefix, so none reach browser bundles.

## Voice AI

The model is an orchestrator. It can only call four tools, implemented in `agent/crm.ts`:

| Tool | Purpose |
|---|---|
| `find_contact` | Search contacts by name (optional email/company). Returns not_found, found or multiple |
| `find_opportunities` | List a contact's opportunities (optional stage filter) |
| `update_opportunity_stage` | Move one opportunity to one of the six valid stages |
| `create_follow_up` | Create a task for a contact/opportunity at an explicit date-time |

The spoken request becomes: `find_contact` → `find_opportunities` → `update_opportunity_stage` → `create_follow_up`, then a short spoken confirmation.

- **Ambiguity:** multiple matching contacts or opportunities, or no match, make the agent ask instead of guess.
- **Dates:** the browser sends its IANA timezone. The model writes a local date-time (e.g. `2026-10-02T10:00:00`) and the tool converts it to UTC using that timezone.
- **Automation hand-off:** if you ask for your own follow-up while moving a deal to Qualified, `create_follow_up` adopts the automatic task and retimes it, so you never get two. If you give a day but no time, the assistant moves the deal and then asks what time you want.
- **Duplicates:** `create_follow_up` is idempotent, and a unique index in the database also blocks duplicate pending follow-ups for the same opportunity, title and time.
- **Live updates:** the agent writes to Postgres; the browser receives changes through Supabase Realtime and refreshes.

## Workflow automation

A Postgres trigger (`supabase/migrations/20261001010000_qualified_automation.sql`) creates the follow-up, so it fires no matter whether the change comes from the UI, the Voice AI, or anywhere else. It skips deals that already have a pending follow-up, and a unique index allows at most one pending automatic task per opportunity.

## Security

- **Authentication:** Supabase Auth; `proxy.ts` validates the session on every request and redirects anonymous users to `/login`.
- **RLS:** enabled on all tables; every policy restricts rows to `auth.uid() = user_id`. Composite foreign keys also prevent linking records across users.
- **Agent runs as the user:** the web app embeds the user's Supabase access token in the LiveKit token metadata (signed with the LiveKit secret). The agent checks that the token belongs to the LiveKit participant identity, then creates a Supabase client authenticated as that user, so RLS applies to every query. The agent holds no service-role key.
- **Tool validation:** every tool validates its input (UUIDs, stage enum, date parsing, same-owner checks) and scopes queries by user, independently of the LLM.
- **No arbitrary SQL:** there is no `execute_sql`-style tool. The model only has the four functions above.
- **Secrets:** keep them in `.env.local` (git-ignored). The LiveKit token route runs server-side only.

## Testing

```bash
npm run test:rls      # RLS and integrity checks against your Supabase project (two users)
npm run test:agent    # CRM tool tests (contact lookup, stage updates, follow-ups, dates)
npm run test:automation  # New -> Qualified automation and its hand-off with the voice tool
npm test              # all three of the above
npm run e2e:voice     # needs `npm run agent:dev` running; sends the acceptance sentence as text
npm run lint
npm run build
```

`e2e:voice` joins a real LiveKit room as the demo user and verifies the database afterwards, so the LLM and tool path is tested without a microphone. Speech-to-text and the browser microphone are verified manually.

## Future improvements

- Activity / audit log
- Workspaces and roles for teams
- Creating contacts and opportunities by voice
