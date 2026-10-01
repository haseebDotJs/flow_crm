-- Demo mode: makes the scheduled email automation visible in ~30 seconds.
--   ON : the follow-up created by New -> Qualified is due in 30 seconds (not 2 days),
--        and the scheduler checks every 10 seconds (not every minute).
--   OFF: normal behaviour.
-- The flag lives here (the database can't read .env); `npm run demo:apply` copies DEMO from
-- .env.local into it, and runs automatically before `npm run dev` and on `npm run seed`.

create table public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Internal: no policies and no grants, so users cannot read or change settings directly.
alter table public.system_settings enable row level security;
revoke all on public.system_settings from anon, authenticated;

create or replace function public.is_demo_mode()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (value)::boolean from public.system_settings where key = 'demo_mode'), false);
$$;

-- Service role only: switch demo mode and retime the scheduler accordingly.
create or replace function public.set_demo_mode(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job bigint;
  sched text := case when p_on then '10 seconds' else '* * * * *' end;
begin
  insert into public.system_settings (key, value) values ('demo_mode', to_jsonb(p_on))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  select jobid into job from cron.job where jobname = 'flowcrm-follow-up-emails';
  if job is null then
    perform cron.schedule('flowcrm-follow-up-emails', sched, 'select public.process_due_follow_up_emails()');
  else
    perform cron.alter_job(job, schedule := sched);
  end if;
  return jsonb_build_object('demo_mode', p_on, 'scheduler_schedule', sched);
end;
$$;

-- The Qualified follow-up is due in 30 s in demo mode, 2 days otherwise.
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
    now() + case when public.is_demo_mode() then interval '30 seconds' else interval '2 days' end,
    'automation',
    tmpl is not null,
    tmpl
  )
  on conflict do nothing;

  return new;
end;
$$;

-- Status now also reports demo mode and the scheduler's schedule (no secrets).
create or replace function public.automation_status()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'provider_configured', exists (select 1 from vault.decrypted_secrets where name = 'resend_api_key'),
    'scheduler_active', exists (select 1 from cron.job where jobname = 'flowcrm-follow-up-emails' and active),
    'scheduler_schedule', (select schedule from cron.job where jobname = 'flowcrm-follow-up-emails'),
    'demo_mode', public.is_demo_mode()
  );
$$;

revoke execute on function
  public.is_demo_mode(),
  public.set_demo_mode(boolean),
  public.create_qualified_follow_up(),
  public.automation_status()
from public, anon, authenticated;
grant execute on function public.is_demo_mode() to service_role;
grant execute on function public.set_demo_mode(boolean) to service_role;
grant execute on function public.automation_status() to authenticated, service_role;
