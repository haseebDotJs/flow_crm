/**
 * Email templates + automated follow-up emails (real Supabase project).
 *
 * Sends are tested against a stand-in endpoint (https://httpbin.org/post) through the
 * service-role-only `endpoint` hook: no provider key is attached and no real email is sent.
 * Usage: npm run test:email
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const STUB = "https://httpbin.org/post";
const STUB_500 = "https://httpbin.org/status/500";
const TEMPLATE = "Follow-up After Qualification";

const admin = createClient(url, secret, opts);
let demo: SupabaseClient;
let other: SupabaseClient;
let demoId = "";
let otherId = "";
let contactId = "";
let oppId = "";
let templateId = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const createdTemplates: string[] = [];
const createdContacts: string[] = [];

async function signIn(email: string, password: string) {
  const c = createClient(url, publishable, opts);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null);
  return { client: c, id: data.user!.id };
}

const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
let seq = 0;

async function mkTask(over: Record<string, unknown> = {}) {
  const { data, error } = await demo
    .from("tasks")
    .insert({
      user_id: demoId,
      contact_id: contactId,
      opportunity_id: oppId,
      title: `Email test ${Date.now()}-${seq++}`,
      due_at: future(),
      auto_email: true,
      email_template_id: templateId,
      ...over,
    })
    .select("id")
    .single();
  assert.equal(error, null, error?.message);
  return data!.id as string;
}

const send = async (task: string, endpoint: string | null = STUB, force = false) => {
  const { data, error } = await admin.rpc("send_task_email", { p_task: task, p_endpoint: endpoint, p_force: force });
  assert.equal(error, null, error?.message);
  return data as { ok: boolean; error?: string; message?: string; status?: string; to?: string; log_id?: string };
};

/** Poll the real reconcile step until the task's email is no longer queued. */
async function settle(task: string, ms = 45_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await admin.rpc("reconcile_email_log");
    const { data } = await admin.from("tasks").select("status, email_status, email_attempts, email_error, email_sent_at").eq("id", task).single();
    if (data && data.email_status !== "queued") return data;
    await sleep(1500);
  }
  throw new Error("Timed out waiting for the email to settle");
}

const logFor = async (task: string) => {
  const { data } = await admin.from("email_log").select("*").eq("task_id", task).order("created_at");
  return data ?? [];
};
const activityFor = async (task: string) => {
  const { data } = await admin.from("activity_log").select("action, actor").eq("entity_id", task).order("created_at");
  return data ?? [];
};

before(async () => {
  const d = await signIn("demo@flowcrm.test", "FlowCRM-demo-2026");
  demo = d.client;
  demoId = d.id;

  const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
  const email = `email-other-${Date.now()}@flowcrm.test`;
  const created = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  otherId = created.data.user!.id;
  other = (await signIn(email, pw)).client;

  const { data: opp } = await demo.from("opportunities").select("id, contact_id").eq("title", "Acme Enterprise License").single();
  oppId = opp!.id;
  contactId = opp!.contact_id;
  const { data: t } = await demo.from("email_templates").select("id").eq("name", TEMPLATE).single();
  templateId = t!.id;

  await demo.from("profiles").update({ email_test_mode: true, email_test_recipient: null }).eq("id", demoId);
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
});

after(async () => {
  await demo.from("profiles").update({ email_test_mode: true, email_test_recipient: null }).eq("id", demoId);
  await demo.from("tasks").delete().eq("opportunity_id", oppId);
  await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
  await demo.from("contacts").delete().in("id", createdContacts);
  await demo.from("email_templates").delete().in("id", createdTemplates);
  await admin.from("email_log").delete().eq("user_id", demoId);
  await admin.auth.admin.deleteUser(otherId);
});

describe("templates", () => {
  it("every user has the three default templates", async () => {
    const mine = await demo.from("email_templates").select("name");
    for (const n of [TEMPLATE, "Proposal Check-in", "Gentle Nudge"]) assert.ok(mine.data!.some((t) => t.name === n), n);
    const theirs = await other.from("email_templates").select("name"); // new signup got defaults via trigger
    assert.equal(theirs.data?.length, 3);
  });

  it("create / edit / delete, with validation", async () => {
    const made = await demo.from("email_templates").insert({ name: "Mine A", subject: "Hello {{first_name}}", body: "Body" }).select("id").single();
    assert.equal(made.error, null);
    createdTemplates.push(made.data!.id);
    const upd = await demo.from("email_templates").update({ subject: "Changed" }).eq("id", made.data!.id).select("subject").single();
    assert.equal(upd.data?.subject, "Changed");

    assert.ok((await demo.from("email_templates").insert({ name: "mine a", subject: "x", body: "y" })).error, "duplicate name (case-insensitive)");
    assert.ok((await demo.from("email_templates").insert({ name: "N", subject: "  ", body: "y" })).error, "blank subject");
    assert.ok((await demo.from("email_templates").insert({ name: "N", subject: "s", body: "b".repeat(5001) })).error, "body too long");

    const del = await demo.from("email_templates").delete().eq("id", made.data!.id).select();
    assert.equal(del.data?.length, 1);
  });

  it("are private to their owner", async () => {
    const seen = await other.from("email_templates").select("id").eq("id", templateId);
    assert.equal(seen.data?.length, 0);
    const upd = await other.from("email_templates").update({ subject: "pwned" }).eq("id", templateId).select();
    assert.equal(upd.data?.length ?? 0, 0);
    const del = await other.from("email_templates").delete().eq("id", templateId).select();
    assert.equal(del.data?.length ?? 0, 0);
  });

  it("render: fills variables in one pass, tolerates spaces, drops unknown ones", async () => {
    const { data } = await admin.rpc("render_email_template", {
      p_text: "Hi {{ first_name }}, {{company}} / {{nope}} / {{sender_name}}",
      p_vars: { first_name: "Ada", company: "{{sender_name}}", sender_name: "Bob" },
    });
    assert.equal(data, "Hi Ada, {{sender_name}} /  / Bob", "a value containing {{...}} is not expanded again");
  });
});

describe("task email settings: users can't forge delivery state", () => {
  it("cannot set or reset system columns", async () => {
    const id = await mkTask();
    for (const patch of [{ email_status: "sent" }, { email_attempts: 0 }, { email_error: "x" }, { email_sent_at: new Date().toISOString() }]) {
      const { error } = await demo.from("tasks").update(patch).eq("id", id);
      assert.ok(error, `must reject ${JSON.stringify(patch)}`);
    }
    assert.ok((await demo.from("tasks").insert({ user_id: demoId, title: "x", due_at: future(), email_status: "sent" })).error);
  });

  it("can turn automation on/off and pick a template, but only its own", async () => {
    const id = await mkTask({ auto_email: false, email_template_id: null });
    const on = await demo.from("tasks").update({ auto_email: true, email_template_id: templateId }).eq("id", id);
    assert.equal(on.error, null);
    const { data: foreign } = await other.from("email_templates").select("id").limit(1).single();
    const bad = await demo.from("tasks").update({ email_template_id: foreign!.id }).eq("id", id);
    assert.ok(bad.error, "template of another user must be rejected");
  });
});

describe("sending (stand-in endpoint, test mode on)", () => {
  let taskId = "";

  it("renders the template, redirects to the test recipient, completes the task, logs activity", async () => {
    taskId = await mkTask();
    const r = await send(taskId);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.to, "demo@flowcrm.test", "test mode sends to the user's own address");

    const task = await settle(taskId);
    assert.equal(task.email_status, "sent");
    assert.equal(task.status, "completed");
    assert.ok(task.email_sent_at);
    assert.equal(task.email_attempts, 1);

    const [log] = await logFor(taskId);
    assert.equal(log.status, "sent");
    assert.equal(log.test_mode, true);
    assert.equal(log.to_email, "demo@flowcrm.test");
    assert.equal(log.intended_email, "john@acme.com");
    assert.equal(log.subject, "[TEST -> john@acme.com] Next steps for Acme Enterprise License");
    assert.match(log.body, /^Hi John,/);
    assert.match(log.body, /Acme Inc\./);
    assert.match(log.body, /Best regards,\nDemo User/);
    assert.match(log.body, /Test mode: this email would have been sent to john@acme\.com/);

    // What the provider actually received (httpbin echoes it back)
    const echo = JSON.parse(log.provider_response);
    assert.deepEqual(echo.json.to, ["demo@flowcrm.test"]);
    assert.equal(echo.json.subject, log.subject);
    assert.equal(echo.json.text, log.body);
    assert.match(echo.json.from, /onboarding@resend\.dev|<.+@.+>/);
    const headers = Object.keys(echo.headers).map((h) => h.toLowerCase());
    assert.ok(!headers.includes("authorization"), "the provider key must never be sent to a stand-in endpoint");

    const acts = await activityFor(taskId);
    const sent = acts.find((a) => a.action === "email_sent");
    const done = acts.find((a) => a.action === "completed");
    assert.ok(sent && sent.actor === "automation", "email_sent is logged as automation");
    assert.ok(done && done.actor === "automation", "completion is attributed to automation, not the user");
  });

  it("sends only once", async () => {
    const again = await send(taskId);
    assert.equal(again.ok, false);
    assert.ok(["already_sent", "not_pending"].includes(again.error!), again.error);
    assert.equal((await logFor(taskId)).length, 1);
  });

  it("two simultaneous runs produce exactly one email", async () => {
    const id = await mkTask();
    const [a, b] = await Promise.all([send(id), send(id)]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, "exactly one caller wins the claim");
    await settle(id);
    assert.equal((await logFor(id)).length, 1);
  });

  it("test mode off sends to the contact's real address", async () => {
    await demo.from("profiles").update({ email_test_mode: false }).eq("id", demoId);
    try {
      const id = await mkTask();
      const r = await send(id);
      assert.equal(r.ok, true);
      assert.equal(r.to, "john@acme.com");
      await settle(id);
      const [log] = await logFor(id);
      assert.equal(log.test_mode, false);
      assert.equal(log.subject, "Next steps for Acme Enterprise License", "no [TEST] prefix");
      assert.ok(!log.body.includes("Test mode:"));
    } finally {
      await demo.from("profiles").update({ email_test_mode: true }).eq("id", demoId);
    }
  });

  it("a follow-up that is not attached to a deal still sends (regression)", async () => {
    // Used to fail with "The contact has no email address" because of a stale `not found` check.
    const id = await mkTask({ opportunity_id: null });
    const r = await send(id);
    assert.equal(r.ok, true, r.message);
    await settle(id);
    const [log] = await logFor(id);
    assert.equal(log.status, "sent");
    assert.equal(log.subject, "[TEST -> john@acme.com] Next steps for ", "deal title is simply empty");
    assert.match(log.body, /^Hi John,/);
  });

  it("honours a custom test recipient", async () => {
    await demo.from("profiles").update({ email_test_recipient: "me@example.com" }).eq("id", demoId);
    try {
      const id = await mkTask();
      const r = await send(id);
      assert.equal(r.to, "me@example.com");
      await settle(id);
    } finally {
      await demo.from("profiles").update({ email_test_recipient: null }).eq("id", demoId);
    }
    const bad = await demo.from("profiles").update({ email_test_recipient: "not an email" }).eq("id", demoId);
    assert.ok(bad.error, "invalid recipient rejected");
  });
});

describe("failures", () => {
  it("a provider error keeps the task pending, records why, and can be retried", async () => {
    const id = await mkTask();
    assert.equal((await send(id, STUB_500)).ok, true, "the call is accepted for sending");
    const failed = await settle(id);
    assert.equal(failed.email_status, "failed");
    assert.equal(failed.status, "pending", "never completed when the email did not go out");
    assert.equal(failed.email_attempts, 1);
    assert.match(failed.email_error!, /500/);
    assert.ok((await activityFor(id)).some((a) => a.action === "email_failed"));

    const retry = await send(id, STUB, true); // "Run automation now" again
    assert.equal(retry.ok, true);
    const ok = await settle(id);
    assert.equal(ok.email_status, "sent");
    assert.equal(ok.status, "completed");
    assert.equal(ok.email_attempts, 2);
  });

  it("a contact without an email address fails clearly", async () => {
    const c = await demo.from("contacts").insert({ user_id: demoId, name: "No Mail" }).select("id").single();
    createdContacts.push(c.data!.id);
    const id = await mkTask({ contact_id: c.data!.id, opportunity_id: null });
    const r = await send(id);
    assert.equal(r.ok, false);
    assert.equal(r.error, "no_email");
    const { data } = await demo.from("tasks").select("status, email_status, email_error").eq("id", id).single();
    assert.equal(data?.status, "pending");
    assert.equal(data?.email_status, "failed");
    assert.match(data!.email_error!, /no email/i);
  });

  it("refuses ineligible follow-ups with a clear reason", async () => {
    const off = await mkTask({ auto_email: false });
    assert.equal((await send(off)).error, "automation_off");
    const noTemplate = await mkTask({ email_template_id: null });
    assert.equal((await send(noTemplate)).error, "no_template");
    const cancelled = await mkTask();
    await demo.from("tasks").update({ status: "cancelled" }).eq("id", cancelled);
    assert.equal((await send(cancelled)).error, "not_pending");
    assert.equal((await send("00000000-0000-4000-8000-000000000000")).error, "not_found");
  });

  it("deleting a template detaches it without deleting the task", async () => {
    const t = await demo.from("email_templates").insert({ name: "Temp tpl", subject: "s", body: "b" }).select("id").single();
    const id = await mkTask({ email_template_id: t.data!.id });
    await demo.from("email_templates").delete().eq("id", t.data!.id);
    const { data } = await demo.from("tasks").select("email_template_id, auto_email").eq("id", id).single();
    assert.equal(data?.email_template_id, null);
    assert.equal((await send(id)).error, "no_template");
  });
});

describe("scheduler", () => {
  it("sends only follow-ups that are due and have automation on", async () => {
    // Uses a throwaway user, not the demo account: the REAL scheduler also runs every minute, and
    // if it ever won a race with this test, a throwaway user's recipient (an @flowcrm.test address,
    // not the Resend account's) is rejected by Resend, so no email can reach a real inbox.
    const pw = `Tmp-${Math.random().toString(36).slice(2)}-Pass1`;
    const email = `sched-${Date.now()}@flowcrm.test`;
    const created = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
    const uid = created.data.user!.id;
    try {
      const sc = (await signIn(email, pw)).client;
      const { data: tpl } = await sc.from("email_templates").select("id").eq("name", TEMPLATE).single();
      const { data: contact } = await sc
        .from("contacts")
        .insert({ user_id: uid, name: "Sched Test", email: "sched@example.com", company: "Schedco" })
        .select("id")
        .single();
      const mk = async (over: Record<string, unknown>) => {
        const { data, error } = await sc
          .from("tasks")
          .insert({ user_id: uid, contact_id: contact!.id, title: `Sched ${seq++}`, auto_email: true, email_template_id: tpl!.id, ...over })
          .select("id")
          .single();
        assert.equal(error, null, error?.message);
        return data!.id as string;
      };

      // Created already due (1 s ago) and processed immediately, so the race window is well under a second.
      const due = await mk({ due_at: new Date(Date.now() - 1000).toISOString() });
      const notDue = await mk({ due_at: future(86_400_000) });
      const off = await mk({ due_at: new Date(Date.now() - 1000).toISOString(), auto_email: false });

      const { data, error } = await admin.rpc("process_due_follow_up_emails", { p_endpoint: STUB });
      assert.equal(error, null);
      assert.ok(Number(data) >= 1);

      await settle(due);
      const states = await Promise.all(
        [due, notDue, off].map(async (id) => (await sc.from("tasks").select("status, email_status").eq("id", id).single()).data!),
      );
      assert.deepEqual(states[0], { status: "completed", email_status: "sent" });
      assert.deepEqual(states[1], { status: "pending", email_status: "none" }, "not due yet");
      assert.deepEqual(states[2], { status: "pending", email_status: "none" }, "automation off");
    } finally {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  it("is registered in the database and reports status without leaking secrets", async () => {
    const { data } = await demo.rpc("automation_status");
    assert.equal(data.scheduler_active, true);
    assert.equal(typeof data.provider_configured, "boolean");
    assert.deepEqual(Object.keys(data).sort(), ["demo_mode", "provider_configured", "scheduler_active", "scheduler_schedule"]);
  });
});

describe("New -> Qualified attaches the default template", () => {
  it("auto follow-up is created with email automation ON, and a voice retime keeps it", async () => {
    await demo.from("tasks").delete().eq("opportunity_id", oppId);
    await demo.from("opportunities").update({ stage: "new" }).eq("id", oppId);
    await demo.from("opportunities").update({ stage: "qualified" }).eq("id", oppId);
    const { data: auto } = await demo.from("tasks").select("id, auto_email, email_template_id, source").eq("opportunity_id", oppId).single();
    assert.equal(auto?.source, "automation");
    assert.equal(auto?.auto_email, true);
    assert.equal(auto?.email_template_id, templateId);

    // the voice flow adopts and retimes it (same updates the agent makes)
    await demo.from("tasks").update({ title: "Follow up with John Smith", due_at: future(), source: "manual" }).eq("id", auto!.id);
    const { data: after } = await demo.from("tasks").select("auto_email, email_template_id").eq("id", auto!.id).single();
    assert.equal(after?.auto_email, true, "retiming keeps the email attached");
    assert.equal(after?.email_template_id, templateId);
  });
});

describe("access control", () => {
  it("other users cannot run, poll, read or tamper with someone else's automation", async () => {
    const id = await mkTask();
    const run = await other.rpc("run_follow_up_automation", { p_task_id: id });
    assert.equal(run.data?.error, "not_found");
    const poll = await other.rpc("refresh_email_status", { p_task_id: id });
    assert.equal(poll.data?.error, "not_found");
    const logs = await other.from("email_log").select("id");
    assert.equal(logs.data?.length, 0);
  });

  it("internal functions are not callable with a user session", async () => {
    const id = await mkTask();
    for (const [fn, args] of [
      ["send_task_email", { p_task: id, p_endpoint: STUB, p_force: true }],
      ["reconcile_email_log", {}],
      ["process_due_follow_up_emails", { p_endpoint: STUB }],
      ["set_email_secret", { p_name: "resend_api_key", p_value: "x" }],
      ["create_default_email_templates", { p_user: demoId }],
    ] as const) {
      const { error } = await demo.rpc(fn, args as never);
      assert.ok(error, `${fn} must be denied to users`);
    }
  });

  it("the owner can use 'run automation now' only on eligible follow-ups (no send for ineligible ones)", async () => {
    const off = await mkTask({ auto_email: false });
    const r = await demo.rpc("run_follow_up_automation", { p_task_id: off });
    assert.equal(r.data?.error, "automation_off");
    const status = await demo.rpc("refresh_email_status", { p_task_id: off });
    assert.equal(status.data?.ok, true);
    assert.equal(status.data?.email_status, "none");
  });
});
