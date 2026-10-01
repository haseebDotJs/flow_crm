-- Email templates + automated follow-up emails.
--
-- Flow:  New -> Qualified  =>  follow-up task (with a default template attached)
--        task due (pg_cron, every minute)  OR  "Run automation now"  =>  send_task_email()
--        provider accepts the email  =>  email_log 'sent', task 'completed', activity logged
--
-- ONE code path: the scheduler and the manual button both call send_task_email().

create extension if not exists pg_cron;

-- --------------------------------------------------------------- profiles
alter table public.profiles
  add column email_test_mode boolean not null default true,
  add column email_test_recipient text
    check (email_test_recipient is null
           or (length(email_test_recipient) <= 200 and email_test_recipient ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'));

-- In test mode every email goes to the user's own address (or this recipient) instead of the contact.
grant update (email_test_mode, email_test_recipient) on public.profiles to authenticated;

-- --------------------------------------------------------------- templates
create table public.email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  subject text not null check (length(btrim(subject)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index email_templates_user_name_idx on public.email_templates (user_id, lower(name));

create trigger email_templates_updated_at before update on public.email_templates
  for each row execute function public.set_updated_at();

alter table public.email_templates enable row level security;
create policy "email_templates_all_own" on public.email_templates
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.email_templates from anon, authenticated;
grant select, insert, update, delete on public.email_templates to authenticated;

create or replace function public.create_default_email_templates(p_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_templates (user_id, name, subject, body) values
    (p_user, 'Follow-up After Qualification',
     'Next steps for {{opportunity_title}}',
     E'Hi {{first_name}},\n\nThanks for taking the time to talk about {{opportunity_title}}. Based on what we discussed, I think {{company}} is a great fit and I''d love to agree on the next steps.\n\nDo you have 20 minutes this week for a quick call?\n\nBest regards,\n{{sender_name}}'),
    (p_user, 'Proposal Check-in',
     'Checking in on our proposal for {{company}}',
     E'Hi {{first_name}},\n\nI wanted to check whether you had a chance to review the proposal for {{opportunity_title}}. I''m happy to walk you through it or adjust anything that doesn''t fit.\n\nWhat would be the best next step on your side?\n\nBest regards,\n{{sender_name}}'),
    (p_user, 'Gentle Nudge',
     'Quick follow-up, {{first_name}}',
     E'Hi {{first_name}},\n\nJust a quick note to follow up on {{opportunity_title}}. If now isn''t the right time, no problem, just let me know and I''ll check back later.\n\nThanks,\n{{sender_name}}')
  on conflict do nothing;
$$;

-- New users get the default templates too.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  perform public.create_default_email_templates(new.id);
  return new;
end;
$$;

-- Existing users get them now.
do $$
declare u record;
begin
  for u in select id from public.profiles loop
    perform public.create_default_email_templates(u.id);
  end loop;
end $$;

-- Replaces {{variables}} in a single pass (values can't inject further placeholders).
-- Unknown variables become empty.
create or replace function public.render_email_template(p_text text, p_vars jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  r text := translate(coalesce(p_text, ''), chr(1) || chr(2), '');
  k text;
  v text;
begin
  r := regexp_replace(r, '\{\{\s*([a-z_]+)\s*\}\}', chr(1) || '\1' || chr(2), 'g');
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    r := replace(r, chr(1) || k || chr(2), translate(coalesce(v, ''), chr(1) || chr(2), ''));
  end loop;
  return regexp_replace(r, chr(1) || '[a-z_]*' || chr(2), '', 'g');
end;
$$;

-- ------------------------------------------------------------------- tasks
alter table public.tasks
  add column auto_email boolean not null default false,
  add column email_template_id uuid,
  add column email_status text not null default 'none'
    check (email_status in ('none', 'queued', 'sent', 'failed')),
  add column email_attempts int not null default 0,
  add column email_sent_at timestamptz,
  add column email_error text;

-- Template must belong to the same user; deleting a template just detaches it.
alter table public.tasks
  add constraint tasks_email_template_fk
  foreign key (email_template_id, user_id)
  references public.email_templates (id, user_id) on delete set null (email_template_id);

create index tasks_email_due_idx on public.tasks (due_at)
  where status = 'pending' and auto_email and email_status in ('none', 'failed');

-- Users configure the automation (auto_email, template) but cannot touch the delivery state
-- (email_status / attempts / error / sent_at): only the system functions below write those.
revoke insert, update on public.tasks from authenticated;
grant insert (user_id, contact_id, opportunity_id, title, description, due_at, auto_email, email_template_id)
  on public.tasks to authenticated;
grant update (contact_id, opportunity_id, title, description, due_at, status, source, auto_email, email_template_id)
  on public.tasks to authenticated;

-- ---------------------------------------------------------------- email log
create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  template_id uuid references public.email_templates (id) on delete set null,
  to_email text not null,
  intended_email text,
  subject text not null,
  body text not null,
  test_mode boolean not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  provider_response text,
  request_id bigint,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_log_user_created_idx on public.email_log (user_id, created_at desc);
create index email_log_queued_idx on public.email_log (created_at) where status = 'queued';

alter table public.email_log enable row level security;
create policy "email_log_select_own" on public.email_log
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.email_log from anon, authenticated;
grant select on public.email_log to authenticated;

alter publication supabase_realtime add table public.email_log;

-- ------------------------------------------------- activity tweaks for email
-- 'automation' can now be set as a transaction-local actor (webhook already could).
create or replace function public.activity_actor()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text;
begin
  v := nullif(current_setting('flowcrm.actor', true), '');
  if v in ('webhook', 'automation') then
    return v;
  end if;
  begin
    v := current_setting('request.headers', true)::json ->> 'x-flowcrm-actor';
  exception when others then
    v := null;
  end;
  return case when v = 'voice' then 'voice' else 'user' end;
end;
$$;

-- Same as before, but delivery bookkeeping columns don't create noisy "updated" entries.
create or replace function public.log_task_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cols text[];
  actor text := public.activity_actor();
  r public.tasks;
  ctx jsonb;
  opp_title text;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select o.title into opp_title from public.opportunities o where o.id = r.opportunity_id;
  ctx := jsonb_build_object('title', r.title)
         || public.contact_context(r.contact_id)
         || case when opp_title is null then '{}'::jsonb else jsonb_build_object('opportunity', opp_title) end;

  if tg_op = 'INSERT' then
    perform public.write_activity(new.user_id, 'task', new.id, 'created',
      'Created task ' || new.title,
      case when new.source = 'automation' then 'automation' else actor end,
      ctx || jsonb_build_object('source', new.source, 'due_at', new.due_at));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.write_activity(new.user_id, 'task', new.id,
        case new.status when 'completed' then 'completed' when 'cancelled' then 'cancelled' else 'reopened' end,
        (case new.status when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' else 'Reopened' end)
          || ' task ' || new.title,
        actor, ctx || jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.due_at is distinct from old.due_at then
      perform public.write_activity(new.user_id, 'task', new.id, 'rescheduled',
        'Rescheduled task ' || new.title, actor,
        ctx || jsonb_build_object('from', old.due_at, 'to', new.due_at));
    end if;
    cols := array(
      select c from unnest(public.changed_columns(to_jsonb(old), to_jsonb(new))) c
      where c not in ('status', 'due_at', 'email_status', 'email_attempts', 'email_error', 'email_sent_at')
    );
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'task', new.id, 'updated',
        'Updated task ' || new.title, actor, ctx || jsonb_build_object('changed', cols));
    end if;
  else
    perform public.write_activity(old.user_id, 'task', old.id, 'deleted',
      'Deleted task ' || old.title, actor, ctx);
  end if;
  return null;
end;
$$;

-- The New -> Qualified follow-up now carries the default template (email goes out when it's due).
-- SECURITY DEFINER because users no longer have table-wide insert rights on tasks.
create or replace function public.create_qualified_follow_up()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_name text;
  tmpl uuid;
begin
  if old.stage is distinct from 'new' or new.stage is distinct from 'qualified' then
    return new;
  end if;

  if exists (
    select 1 from public.tasks
    where opportunity_id = new.id and user_id = new.user_id and status = 'pending'
  ) then
    return new;
  end if;

  select c.name into contact_name
  from public.contacts c where c.id = new.contact_id and c.user_id = new.user_id;

  select t.id into tmpl
  from public.email_templates t
  where t.user_id = new.user_id and lower(t.name) = 'follow-up after qualification';

  insert into public.tasks (user_id, contact_id, opportunity_id, title, due_at, source, auto_email, email_template_id)
  values (
    new.user_id, new.contact_id, new.id,
    'Follow up with ' || coalesce(contact_name, 'contact'),
    now() + interval '2 days',
    'automation',
    tmpl is not null,
    tmpl
  )
  on conflict do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------- sending
-- Result helper: {ok:false, error, message}
create or replace function public.email_error(p_code text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$ select jsonb_build_object('ok', false, 'error', p_code, 'message', p_message); $$;

-- Records a failed attempt (used for problems detected before the provider is called).
create or replace function public.fail_task_email(
  p_task public.tasks, p_recipient text, p_intended text, p_subject text, p_body text,
  p_test boolean, p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tasks
  set email_status = 'failed', email_attempts = email_attempts + 1, email_error = p_message
  where id = p_task.id;

  insert into public.email_log (user_id, task_id, template_id, to_email, intended_email, subject, body,
                                test_mode, status, error)
  values (p_task.user_id, p_task.id, p_task.email_template_id, coalesce(p_recipient, '(none)'), p_intended,
          coalesce(p_subject, '(not rendered)'), coalesce(p_body, ''), p_test, 'failed', p_message);

  perform public.write_activity(p_task.user_id, 'task', p_task.id, 'email_failed',
    'Email failed: ' || p_message, 'automation', jsonb_build_object('title', p_task.title, 'error', p_message));
end;
$$;

-- THE sending function. Called by the scheduler and by "Run automation now".
--   p_force:    ignore the retry cap (manual run)
--   p_endpoint: test hook (service role only): post to a stand-in URL, without the provider key
create or replace function public.send_task_email(
  p_task uuid,
  p_endpoint text default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  tmpl public.email_templates;
  c public.contacts;
  o public.opportunities;
  prof public.profiles;
  api_key text;
  from_addr text;
  auth_email text;
  recipient text;
  subj text;
  body text;
  vars jsonb;
  rid bigint;
  logid uuid;
  test boolean;
begin
  select * into t from public.tasks where id = p_task;
  if not found then return public.email_error('not_found', 'Follow-up not found.'); end if;
  if t.status <> 'pending' then
    return public.email_error('not_pending', 'This follow-up is already ' || t.status || '.');
  end if;
  if not t.auto_email then
    return public.email_error('automation_off', 'Email automation is off for this follow-up.');
  end if;
  if t.email_template_id is null then
    return public.email_error('no_template', 'Choose an email template first.');
  end if;
  if t.email_status = 'queued' then
    return public.email_error('already_queued', 'An email is already being sent.');
  end if;
  if t.email_status = 'sent' then
    return public.email_error('already_sent', 'The email for this follow-up was already sent.');
  end if;
  if not p_force and t.email_attempts >= 3 then
    return public.email_error('attempts_exhausted', 'Gave up after 3 failed attempts. Use "Run automation now" to retry.');
  end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null and p_endpoint is null then
    return public.email_error('not_configured', 'Email is not configured yet (no provider key).');
  end if;
  select decrypted_secret into from_addr from vault.decrypted_secrets where name = 'resend_from';
  from_addr := coalesce(from_addr, 'FlowCRM <onboarding@resend.dev>');

  select * into tmpl from public.email_templates where id = t.email_template_id and user_id = t.user_id;
  select * into prof from public.profiles where id = t.user_id;
  select email into auth_email from auth.users where id = t.user_id;
  select * into c from public.contacts where id = t.contact_id and user_id = t.user_id;
  select * into o from public.opportunities where id = t.opportunity_id and user_id = t.user_id;
  test := coalesce(prof.email_test_mode, true);

  if not found or c.id is null or nullif(btrim(coalesce(c.email, '')), '') is null then
    perform public.fail_task_email(t, null, c.email, null, null, test, 'The contact has no email address.');
    return public.email_error('no_email', 'The contact has no email address.');
  end if;

  vars := jsonb_build_object(
    'contact_name', c.name,
    'first_name', split_part(btrim(c.name), ' ', 1),
    'company', coalesce(c.company, ''),
    'opportunity_title', coalesce(o.title, ''),
    'sender_name', coalesce(prof.full_name, '')
  );
  -- header-injection safe subject (no line breaks)
  subj := regexp_replace(public.render_email_template(tmpl.subject, vars), '[\r\n]+', ' ', 'g');
  body := public.render_email_template(tmpl.body, vars);

  if test then
    recipient := coalesce(prof.email_test_recipient, auth_email);
    subj := '[TEST -> ' || c.email || '] ' || subj;
    body := body || E'\n\n---\n(Test mode: this email would have been sent to ' || c.email || '.)';
  else
    recipient := c.email;
  end if;

  -- Atomic claim: only one caller can move the task to 'queued'.
  update public.tasks
  set email_status = 'queued', email_attempts = email_attempts + 1, email_error = null
  where id = p_task and status = 'pending' and email_status in ('none', 'failed')
  returning * into t;
  if not found then
    return public.email_error('already_queued', 'An email is already being sent.');
  end if;

  begin
    rid := net.http_post(
      url := coalesce(p_endpoint, 'https://api.resend.com/emails'),
      body := jsonb_build_object('from', from_addr, 'to', jsonb_build_array(recipient),
                                 'subject', subj, 'text', body),
      headers := case when p_endpoint is null
        then jsonb_build_object('Content-Type', 'application/json', 'User-Agent', 'FlowCRM/1.0',
                                'Authorization', 'Bearer ' || api_key)
        else jsonb_build_object('Content-Type', 'application/json') end,
      timeout_milliseconds := 10000
    );
  exception when others then
    perform public.fail_task_email(t, recipient, c.email, subj, body, test, 'Could not call the email provider: ' || sqlerrm);
    return public.email_error('send_failed', 'Could not call the email provider.');
  end;

  insert into public.email_log (user_id, task_id, template_id, to_email, intended_email, subject, body,
                                test_mode, status, request_id)
  values (t.user_id, t.id, t.email_template_id, recipient, c.email, subj, body, test, 'queued', rid)
  returning id into logid;

  return jsonb_build_object('ok', true, 'status', 'queued', 'log_id', logid, 'to', recipient, 'test_mode', test);
end;
$$;

-- Turns finished HTTP calls into results: sent -> task completed + activity; failed -> error kept.
create or replace function public.reconcile_email_log()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.email_log;
  r record;
  n int := 0;
  ok boolean;
  msg text;
  tk public.tasks;
  ctx jsonb;
begin
  for l in
    select * from public.email_log where status = 'queued' order by created_at for update skip locked
  loop
    select * into r from net._http_response where id = l.request_id;
    if found then
      ok := r.status_code between 200 and 299 and r.error_msg is null and not coalesce(r.timed_out, false);
      msg := case when ok then null
                  else coalesce(r.error_msg,
                                'Email provider responded HTTP ' || coalesce(r.status_code::text, '?') || ': ' ||
                                left(coalesce(r.content, ''), 300)) end;
    elsif l.created_at < now() - interval '2 minutes' then
      ok := false;
      msg := 'No response from the email provider (timed out).';
    else
      continue;
    end if;

    select * into tk from public.tasks where id = l.task_id;
    ctx := jsonb_build_object('title', coalesce(tk.title, ''), 'to', l.to_email, 'subject', l.subject,
                              'test_mode', l.test_mode)
           || public.contact_context(tk.contact_id);

    perform set_config('flowcrm.actor', 'automation', true);
    if ok then
      update public.email_log
      set status = 'sent', sent_at = now(), provider_response = left(coalesce(r.content, ''), 4000)
      where id = l.id;
      update public.tasks
      set email_status = 'sent', email_sent_at = now(), email_error = null,
          status = case when status = 'pending' then 'completed' else status end
      where id = l.task_id;
      perform public.write_activity(l.user_id, 'task', l.task_id, 'email_sent',
        'Emailed ' || coalesce(l.intended_email, l.to_email) || ': ' || l.subject, 'automation', ctx);
    else
      update public.email_log
      set status = 'failed', error = msg, provider_response = left(coalesce(r.content, ''), 4000)
      where id = l.id;
      update public.tasks set email_status = 'failed', email_error = msg where id = l.task_id;
      perform public.write_activity(l.user_id, 'task', l.task_id, 'email_failed',
        'Email failed: ' || msg, 'automation', ctx || jsonb_build_object('error', msg));
    end if;
    perform set_config('flowcrm.actor', '', true);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- The scheduled job: send emails for follow-ups that have come due. Failed ones retry
-- (max 3 attempts, at least 2 minutes apart).
create or replace function public.process_due_follow_up_emails(p_endpoint text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  n int := 0;
begin
  for t in
    select id from public.tasks
    where status = 'pending' and auto_email and email_template_id is not null
      and due_at <= now()
      and email_attempts < 3
      and (email_status = 'none' or (email_status = 'failed' and updated_at < now() - interval '2 minutes'))
    order by due_at
    limit 25
  loop
    if (public.send_task_email(t.id, p_endpoint) ->> 'ok')::boolean then n := n + 1; end if;
  end loop;
  perform public.reconcile_email_log();
  return n;
end;
$$;

-- Every minute, inside the database.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'flowcrm-follow-up-emails') then
    perform cron.unschedule('flowcrm-follow-up-emails');
  end if;
  perform cron.schedule('flowcrm-follow-up-emails', '* * * * *', 'select public.process_due_follow_up_emails()');
end $$;

-- ------------------------------------------------------- user-facing RPCs
-- "Run automation now": the same send function, ignoring the due time.
create or replace function public.run_follow_up_automation(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.tasks where id = p_task_id and user_id = (select auth.uid())) then
    return public.email_error('not_found', 'Follow-up not found.');
  end if;
  return public.send_task_email(p_task_id, null, true);
end;
$$;

-- Live status for the demo panel: reconciles finished calls, then reports what really happened.
create or replace function public.refresh_email_status(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  l public.email_log;
begin
  select * into t from public.tasks where id = p_task_id and user_id = (select auth.uid());
  if not found then return public.email_error('not_found', 'Follow-up not found.'); end if;

  perform public.reconcile_email_log();
  select * into t from public.tasks where id = p_task_id;
  select * into l from public.email_log where task_id = p_task_id order by created_at desc limit 1;

  return jsonb_build_object(
    'ok', true,
    'task_status', t.status,
    'email_status', t.email_status,
    'email_error', t.email_error,
    'to', l.to_email,
    'intended', l.intended_email,
    'subject', l.subject,
    'test_mode', l.test_mode,
    'activity_logged', coalesce((
      select true from public.activity_log a
      where a.entity_id = p_task_id and a.action in ('email_sent', 'email_failed')
        and a.created_at >= l.created_at limit 1), false)
  );
end;
$$;

-- Is email set up, and is the scheduler running? (No secrets are exposed.)
create or replace function public.automation_status()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'provider_configured', exists (select 1 from vault.decrypted_secrets where name = 'resend_api_key'),
    'scheduler_active', exists (select 1 from cron.job where jobname = 'flowcrm-follow-up-emails' and active)
  );
$$;

-- Service-role only: store the provider key in the encrypted secret store.
create or replace function public.set_email_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  sid uuid;
begin
  if p_name not in ('resend_api_key', 'resend_from') then
    raise exception 'unknown secret name';
  end if;
  select id into sid from vault.secrets where name = p_name;
  if sid is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(sid, p_value);
  end if;
end;
$$;

-- ------------------------------------------------------------------ grants
revoke execute on function
  public.create_default_email_templates(uuid),
  public.render_email_template(text, jsonb),
  public.email_error(text, text),
  public.fail_task_email(public.tasks, text, text, text, text, boolean, text),
  public.send_task_email(uuid, text, boolean),
  public.reconcile_email_log(),
  public.process_due_follow_up_emails(text),
  public.run_follow_up_automation(uuid),
  public.refresh_email_status(uuid),
  public.automation_status(),
  public.set_email_secret(text, text)
from public, anon, authenticated;

grant execute on function public.render_email_template(text, jsonb) to authenticated, service_role;
grant execute on function public.run_follow_up_automation(uuid) to authenticated;
grant execute on function public.refresh_email_status(uuid) to authenticated;
grant execute on function public.automation_status() to authenticated, service_role;
-- internal / test hooks: service role only
grant execute on function public.create_default_email_templates(uuid) to service_role;
grant execute on function public.send_task_email(uuid, text, boolean) to service_role;
grant execute on function public.reconcile_email_log() to service_role;
grant execute on function public.process_due_follow_up_emails(text) to service_role;
grant execute on function public.set_email_secret(text, text) to service_role;
