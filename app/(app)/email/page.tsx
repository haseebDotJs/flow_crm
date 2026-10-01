import { EmailLogList, EmailSettings, NewTemplateButton, StatusCard, TemplateList } from "@/components/email-panels";
import { EmptyState, ErrorState } from "@/components/states";
import { createClient } from "@/lib/supabase/server";
import type { EmailLogEntry, EmailTemplate } from "@/types";

export const metadata = { title: "Email · FlowCRM" };

export default async function EmailPage() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;

  const [templates, profile, status, log] = await Promise.all([
    supabase.from("email_templates").select("*").order("name"),
    supabase.from("profiles").select("email_test_mode, email_test_recipient").eq("id", userId ?? "").maybeSingle(),
    supabase.rpc("automation_status"),
    supabase.from("email_log").select("*").order("created_at", { ascending: false }).limit(15),
  ]);

  const error = templates.error || profile.error || status.error || log.error;
  if (error) return <ErrorState message={`Could not load email settings: ${error.message}`} />;

  const list = (templates.data ?? []) as EmailTemplate[];
  const entries = (log.data ?? []) as EmailLogEntry[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Email</h1>
        <p className="text-sm text-slate-500">
          Templates for automated follow-up emails. When a follow-up with automation turned on comes due, FlowCRM sends the
          email, completes the task and logs it.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Status</h2>
          <StatusCard
            providerConfigured={!!status.data?.provider_configured}
            schedulerActive={!!status.data?.scheduler_active}
          />
        </section>
        <section className="card">
          <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Sending</h2>
          <EmailSettings
            testMode={profile.data?.email_test_mode ?? true}
            testRecipient={profile.data?.email_test_recipient ?? null}
            loginEmail={auth.user?.email ?? ""}
          />
        </section>
      </div>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Templates</h2>
            <p className="text-xs text-slate-500">
              Variables: <code>{"{{first_name}}"}</code> <code>{"{{contact_name}}"}</code> <code>{"{{company}}"}</code>{" "}
              <code>{"{{opportunity_title}}"}</code> <code>{"{{sender_name}}"}</code>
            </p>
          </div>
          <NewTemplateButton />
        </div>
        {list.length === 0 ? (
          <div className="p-4"><EmptyState title="No templates yet" hint="Create one to attach to follow-ups." /></div>
        ) : (
          <TemplateList templates={list} />
        )}
      </section>

      <section className="card">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Recent emails</h2>
        {entries.length === 0 ? (
          <div className="p-4"><EmptyState title="No emails sent yet" hint="Turn on email automation for a follow-up, then use “Run automation now” on the Tasks page." /></div>
        ) : (
          <EmailLogList entries={entries} />
        )}
      </section>
    </div>
  );
}
