# FlowCRM — AI-Powered Sales CRM

## 1. Objective

Build a polished, lightweight SaaS CRM called **FlowCRM**.

The core purpose is to demonstrate one complete workflow:

> A signed-in user can tell a Voice AI agent:
>
> "Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM."

The Voice AI should understand the request, find the correct CRM records, invoke structured CRM tools, update the database, create the follow-up, and reflect the changes in the UI.

The application should feel like a coherent real product, not a collection of unrelated demos.

---

# 2. CRITICAL DEVELOPMENT PRIORITY

This project must be built in priority order.

## P0 — Mandatory

The following must be fully functional before anything else:

1. Supabase authentication
2. Protected CRM dashboard
3. Contacts
4. Opportunities
5. Sales pipeline
6. Follow-up tasks
7. LiveKit Voice AI
8. Structured CRM tools for the Voice AI
9. Voice command → CRM mutation → database → UI workflow
10. Basic RLS/security
11. Seed/demo data
12. README and `.env.example`
13. Successful production build

## P1 — Only after P0 is completely working

Only add these if P0 is stable and there is sufficient time/tokens:

* Basic automated workflow when an opportunity becomes Qualified
* Basic audit/activity log
* Basic role field
* Workspace abstraction
* Better ambiguity handling
* Additional UI polish

## P2 — Do not implement unless everything above is already complete

* Advanced RBAC
* Organization management
* Invitations
* Calendar integrations
* Email integrations
* Complex automation engine
* Voice deletion
* Advanced analytics
* Multiple AI providers
* RAG
* Vector database
* n8n
* FastAPI
* Redis
* Additional infrastructure
* Billing
* Notifications system

### VERY IMPORTANT

Do NOT attempt to implement every possible feature before validating the core workflow.

If implementation complexity, token usage, or time becomes a concern:

**Stop adding features and make P0 complete and reliable.**

A smaller fully working product is preferable to a larger partially working product.

---

# 3. Technology Stack

Use:

* Next.js
* TypeScript
* App Router
* Tailwind CSS
* Supabase
* Supabase Auth
* Supabase PostgreSQL
* Supabase Row Level Security
* LiveKit Agents
* LiveKit Cloud
* LiveKit Inference where practical
* React
* Lucide icons or another lightweight icon library

Do NOT introduce FastAPI.

Do NOT introduce a local PostgreSQL database.

Do NOT require Docker for the database.

Do NOT introduce unnecessary infrastructure.

Supabase should provide the hosted PostgreSQL database and authentication.

---

# 4. Product Name

The product name is:

**FlowCRM**

Do not use words such as:

* assessment
* assignment
* challenge
* evaluation
* hiring
* interview
* candidate
* recruitment test

in the application UI, repository name, README, metadata, or project description.

Treat FlowCRM as a standalone SaaS product.

---

# 5. Core User Flow

The most important workflow is:

1. User opens FlowCRM.
2. User logs in.
3. User sees the CRM dashboard.
4. User sees an opportunity belonging to John Smith.
5. John Smith's opportunity is initially in `New`.
6. User opens the Voice Assistant.
7. User says:

> "Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM."

8. LiveKit receives the voice input.
9. Voice AI interprets the request.
10. Agent calls `find_contact`.
11. Agent finds John Smith.
12. Agent calls `find_opportunities`.
13. Agent identifies John's opportunity.
14. Agent calls `update_opportunity_stage`.
15. Agent calls `create_follow_up`.
16. Supabase database is updated.
17. Frontend reflects the updated stage and task.
18. Voice AI responds:

> "Done. John Smith's opportunity is now Qualified, and I've scheduled a follow-up for tomorrow at 10 AM."

This workflow is the primary success criterion.

---

# 6. Database

Keep the initial database simple.

Use these tables:

## profiles

```text
id
full_name
created_at
updated_at
```

`id` should reference `auth.users`.

## contacts

```text
id
user_id
name
email
phone
company
notes
created_at
updated_at
```

## opportunities

```text
id
user_id
contact_id
title
value
stage
notes
created_at
updated_at
```

Stages:

```text
new
qualified
proposal
negotiation
won
lost
```

## tasks

```text
id
user_id
contact_id
opportunity_id
title
description
due_at
status
created_at
updated_at
```

Statuses:

```text
pending
completed
cancelled
```

Do not introduce a complicated workspace schema during P0.

If P0 is complete and there is plenty of time, workspace support can be added later.

---

# 7. Supabase Security

Enable Row Level Security on CRM tables.

Authenticated users should only be able to access their own CRM records.

Do not rely only on frontend UI restrictions.

The backend/database must enforce authorization.

Never expose:

* Supabase service-role/secret keys
* LiveKit API secrets
* AI provider secrets

to browser-side code.

Never put secrets in `NEXT_PUBLIC_*` variables.

Use the current Supabase Next.js SSR approach with `@supabase/ssr`.

Do not use deprecated Supabase authentication helper packages.

---

# 8. Authentication

Implement:

* Sign up
* Login
* Logout
* Protected routes
* Authenticated session handling

Use Supabase Auth with email/password.

Unauthenticated users should be redirected to `/login`.

Authenticated users should be able to access the CRM.

Create a basic profile row after signup if appropriate.

Do not build:

* Google login
* GitHub login
* MFA
* invitation systems
* complex account management

unless everything else is already complete.

---

# 9. CRM Dashboard

Create a clean SaaS dashboard.

Sidebar:

```text
Dashboard
Contacts
Pipeline
Tasks
```

User section:

```text
User name
Logout
```

Dashboard should show:

* total contacts
* total opportunities
* total pipeline value
* upcoming follow-ups
* pipeline stage summary
* Voice AI button

Do not spend excessive time building analytics.

Simple cards are sufficient.

---

# 10. Contacts

Implement:

* list contacts
* search contacts
* create contact
* edit contact
* contact details

Contact details should show:

* name
* email
* phone
* company
* associated opportunities
* associated tasks

Keep the UI simple.

---

# 11. Opportunities / Pipeline

Use a simple Kanban-style pipeline.

Columns:

```text
New
Qualified
Proposal
Negotiation
Won
Lost
```

Each opportunity card should show:

* title
* contact
* company
* value
* stage

Users should be able to change an opportunity stage.

Prefer a simple dropdown/select if drag-and-drop would consume significant implementation time.

Do not sacrifice reliability for drag-and-drop.

---

# 12. Opportunity Details

Show:

* title
* value
* stage
* contact
* notes
* created date
* updated date
* related tasks

Allow the user to change the stage.

---

# 13. Follow-up Tasks

Create a Tasks page.

Show:

* task title
* associated contact
* associated opportunity
* due date
* status

Implement:

* create task
* mark complete
* cancel task

Highlight:

* overdue
* today
* tomorrow
* upcoming

Keep task functionality simple.

---

# 14. Voice AI

This is the most important technical component.

Use **LiveKit Agents** and **LiveKit Cloud**.

The browser should connect to LiveKit.

The Voice Agent should join the appropriate room and handle the conversation.

The Voice AI should be capable of:

1. Listening to the user.
2. Understanding natural language.
3. Calling CRM tools.
4. Receiving tool results.
5. Calling additional tools when required.
6. Speaking a concise confirmation.

The AI should act as an orchestrator.

---

# 15. Voice CRM Tools

Implement only the tools required for the core workflow.

## Tool 1: find_contact

Input:

```text
name
```

Optional:

```text
email
company
```

Return:

* contact ID
* name
* company
* email

If there are no matches, tell the user.

If multiple contacts match, ask for clarification.

---

## Tool 2: find_opportunities

Input:

```text
contact_id
```

Optional:

```text
stage
```

Return matching opportunities.

If a contact has multiple opportunities and the user did not clearly specify which one to update, the AI should ask for clarification.

---

## Tool 3: update_opportunity_stage

Input:

```text
opportunity_id
stage
```

Allowed stages:

```text
new
qualified
proposal
negotiation
won
lost
```

The tool must:

1. Validate the stage.
2. Validate the authenticated user's access to the opportunity.
3. Update the opportunity.
4. Return the updated opportunity.

Do not allow arbitrary database queries.

---

## Tool 4: create_follow_up

Input:

```text
contact_id
opportunity_id
title
due_at
```

The tool must:

1. Validate the authenticated user's access.
2. Validate the referenced records.
3. Create the task.
4. Return the created task.

---

# 16. Voice AI Safety

The LLM must NEVER receive a generic database tool.

Do NOT implement:

```text
execute_sql()
```

Do NOT implement:

```text
raw_database_query()
```

Do NOT allow the model to construct arbitrary SQL.

The architecture should be:

```text
User voice
    ↓
LiveKit
    ↓
AI Agent
    ↓
Structured CRM Tool
    ↓
Authorization + Validation
    ↓
Supabase
    ↓
Result
    ↓
AI Agent
    ↓
Voice response
```

Every tool must independently validate authorization.

Do not rely on the LLM to enforce permissions.

---

# 17. Ambiguity

The agent should avoid making dangerous assumptions.

If there is one John Smith:

> "Move John Smith to Qualified."

The agent can proceed.

If there are multiple John Smith contacts:

> "I found multiple contacts named John Smith. Which one do you mean?"

If John Smith has multiple opportunities:

> "John Smith has multiple opportunities. Which one should I move to Qualified?"

If the contact doesn't exist:

> "I couldn't find John Smith. Would you like to create a new contact?"

Do not invent CRM records.

---

# 18. Follow-up Date Handling

The agent should understand natural language dates.

For example:

```text
tomorrow
tomorrow at 10 AM
next Monday
Friday afternoon
```

Convert these into an explicit datetime before calling the tool.

Respect the user's local timezone where possible.

Avoid silently assuming UTC when a local timezone is known.

---

# 19. Automated Workflow

Only implement this during P0 if it is straightforward.

Preferred automation:

When an opportunity moves from:

```text
New → Qualified
```

automatically create a follow-up task:

```text
Follow up with [Contact Name]
```

due approximately two days later.

However:

**Do not allow this automation to interfere with the explicit voice-requested follow-up.**

Avoid creating duplicate tasks.

If implementing this automation would delay or destabilize the Voice AI workflow, defer it until P0 is complete.

---

# 20. Seed Data

Provide demo data.

Contacts:

```text
John Smith
Acme Inc.
john@acme.com

Sarah Williams
Globex
sarah@globex.com

Mike Johnson
Stark Industries
mike@stark.com

Emily Davis
Northstar
emily@northstar.com
```

Create opportunities such as:

```text
Acme Enterprise License
Contact: John Smith
Value: $25,000
Stage: New

Globex Expansion
Contact: Sarah Williams
Value: $40,000
Stage: Qualified

Stark Platform Contract
Contact: Mike Johnson
Value: $15,000
Stage: Proposal

Northstar Renewal
Contact: Emily Davis
Value: $30,000
Stage: Negotiation
```

Create a few sample tasks.

The demo environment should make the Voice AI workflow immediately testable.

---

# 21. UI Quality

The UI should look like a modern B2B SaaS application.

Use:

* clean spacing
* consistent typography
* clear cards
* sensible colors
* status badges
* responsive layout
* loading states
* empty states
* error states
* toast notifications

Do not spend excessive time on visual effects.

Functional quality is more important.

---

# 22. Voice UI

The Voice Assistant should have clear states:

```text
Idle
Connecting
Listening
Processing
Speaking
Error
```

Example:

```text
Talk to your CRM
```

When active:

```text
Listening...
```

Show a transcript or recent interaction if reasonably easy.

The user should clearly understand whether the microphone is active.

Handle microphone permission errors.

---

# 23. Environment Variables

Create `.env.example`.

Expected variables:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=

LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

Only add provider-specific AI keys if the chosen LiveKit configuration actually requires them.

Do not invent environment variables unnecessarily.

Do not expose secrets to the browser.

---

# 24. Project Structure

Use a clean structure.

A reasonable architecture is:

```text
flowcrm/
├── app/
├── components/
├── lib/
├── types/
├── supabase/
│   ├── migrations/
│   └── seed/
├── agent/
│   ├── ...
│   └── ...
├── public/
├── .env.example
├── README.md
└── package.json
```

Adjust the structure if the current Next.js/LiveKit best practices suggest a better organization.

Keep the web application and Voice Agent logically separated.

---

# 25. Database Migrations

Create reproducible Supabase migrations.

Do not rely solely on manual dashboard configuration.

Include:

* tables
* constraints
* indexes where useful
* RLS policies
* required functions/triggers
* seed data

The project should be reproducible by another developer.

---

# 26. Testing

Do not chase high test coverage.

Focus on critical functionality.

At minimum, validate:

* authentication
* RLS
* opportunity stage validation
* contact lookup
* opportunity lookup
* stage update
* task creation
* Voice AI tool execution

If automated tests are practical, implement them.

Otherwise, perform a clear manual verification of the golden workflow.

---

# 27. README

Create a professional README.

Include:

## Overview

What FlowCRM does.

## Features

List only features that actually exist.

## Architecture

Explain:

```text
Next.js
   ↓
Supabase Auth / PostgreSQL / RLS
```

and:

```text
Browser
   ↓
LiveKit
   ↓
Voice Agent
   ↓
CRM Tools
   ↓
Supabase
```

## Setup

Explain:

1. Install dependencies.
2. Create Supabase project.
3. Configure Supabase environment variables.
4. Run migrations.
5. Seed demo data.
6. Create LiveKit project.
7. Configure LiveKit credentials.
8. Start Next.js.
9. Start Voice Agent.

## Environment Variables

Explain every variable.

Never include real credentials.

## Voice AI

Explain how the Voice Agent interacts with CRM tools.

## Security

Explain:

* authentication
* RLS
* tool validation
* no arbitrary SQL
* secret handling

## Future Improvements

Only mention features that would genuinely make sense as future work.

---

# 28. External Services

Do not pretend that external accounts or credentials have been configured.

If Supabase or LiveKit requires manual setup:

1. Tell me exactly what I need to create.
2. Tell me where to find each credential.
3. Tell me which environment variable it belongs to.
4. Wait for me to provide/configure it when necessary.

Never fabricate:

* API keys
* URLs
* project IDs
* tokens
* secrets

---

# 29. Development Workflow

Before implementing:

1. Inspect the repository.
2. Inspect installed Node/Python versions if relevant.
3. Check current package versions.
4. Check current official Supabase integration patterns.
5. Check current LiveKit Agents integration patterns.
6. Identify anything in this specification that conflicts with current APIs.
7. Give me a concise implementation plan.

Do not begin by generating large amounts of code blindly.

After the plan is approved:

### Phase 1

Implement:

* project setup
* Supabase integration
* authentication
* database
* RLS
* contacts
* opportunities
* tasks

### Phase 2

Implement:

* pipeline
* seed data
* polished basic UI

### Phase 3

Implement:

* LiveKit
* Voice Agent
* CRM tools
* tool authorization
* core voice workflow

### Phase 4

Test the complete workflow.

### Phase 5

Only if the complete workflow is stable, consider P1 features.

---

# 30. Core Acceptance Test

Before declaring the project complete, manually verify this exact scenario.

Initial state:

```text
John Smith
Acme Inc.

Opportunity:
Acme Enterprise License
Value: $25,000
Stage: New
```

User logs in.

User opens Voice Assistant.

User says:

> "Move John Smith to Qualified and create a follow-up for tomorrow at 10 AM."

Expected:

1. Voice input is received.
2. Agent understands the request.
3. Agent finds John Smith.
4. Agent finds the correct opportunity.
5. Agent updates the opportunity to Qualified.
6. Agent creates the follow-up.
7. Database contains the changes.
8. Pipeline displays John Smith under Qualified.
9. Tasks page displays the new follow-up.
10. Agent speaks a confirmation.

If any of these fail, prioritize fixing the failure over adding new features.

---

# 31. Final Quality Gate

Before declaring the project complete:

* `npm run lint` passes.
* `npm run build` passes.
* No obvious TypeScript errors.
* Authentication works.
* Protected routes work.
* RLS works.
* Contacts work.
* Opportunities work.
* Pipeline works.
* Tasks work.
* LiveKit connection works.
* Microphone works.
* Voice Agent works.
* CRM tools work.
* Voice command successfully updates the CRM.
* No duplicate follow-ups are created by accidental repeated tool calls.
* Secrets are not exposed to client-side code.
* README setup instructions are accurate.
* `.env.example` is complete.
* No assessment/hiring terminology exists in the product.

---

# 32. Final Instruction

The primary objective is NOT to build the largest possible CRM.

The primary objective is to build a **small, polished, reliable CRM with one excellent Voice AI workflow**.

Always prioritize:

**working core functionality > security correctness > reliable AI tool calling > UI polish > additional features**

If you have limited time or tokens:

**STOP adding features and finish the core workflow.**

Do not leave the project in a partially implemented state because of optional features.

Only add P1/P2 features after the P0 workflow has been tested end-to-end and is working reliably.
