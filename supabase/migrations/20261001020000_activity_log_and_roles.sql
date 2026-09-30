-- P1: activity/audit log and a basic role field.

-- ------------------------------------------------------------------- roles
alter table public.profiles
  add column role text not null default 'member'
    check (role in ('admin', 'member'));

-- Users must not be able to promote themselves: only full_name is user-editable.
-- (role changes need the service key / SQL editor.)
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- ------------------------------------------------------------ activity log
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_type text not null check (entity_type in ('contact', 'opportunity', 'task')),
  entity_id uuid not null,
  action text not null,
  summary text not null,
  actor text not null default 'user' check (actor in ('user', 'voice', 'automation')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_log_user_created_idx on public.activity_log (user_id, created_at desc);
create index activity_log_entity_idx on public.activity_log (entity_type, entity_id);

alter table public.activity_log enable row level security;

-- Read-only for users; rows are written exclusively by the SECURITY DEFINER triggers below.
create policy "activity_log_select_own" on public.activity_log
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

alter publication supabase_realtime add table public.activity_log;

-- Who made the change? The Voice AI sends `x-flowcrm-actor: voice`. This is informational
-- (it only labels the user's own log entries), not a security boundary.
create or replace function public.activity_actor()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text;
begin
  begin
    v := current_setting('request.headers', true)::json ->> 'x-flowcrm-actor';
  exception when others then
    v := null;
  end;
  return case when v = 'voice' then 'voice' else 'user' end;
end;
$$;

-- Names of columns whose value differs between two rows (ignoring bookkeeping columns).
create or replace function public.changed_columns(old_row jsonb, new_row jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(n.key order by n.key), '{}')
  from jsonb_each(new_row) n
  join jsonb_each(old_row) o using (key)
  where n.value is distinct from o.value
    and n.key not in ('updated_at', 'created_at');
$$;

create or replace function public.write_activity(
  p_user uuid,
  p_type text,
  p_entity uuid,
  p_action text,
  p_summary text,
  p_actor text,
  p_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Skip when the owner is being deleted (cascade) so account deletion still works.
  if not exists (select 1 from auth.users where id = p_user) then
    return;
  end if;
  insert into public.activity_log (user_id, entity_type, entity_id, action, summary, actor, metadata)
  values (p_user, p_type, p_entity, p_action, p_summary, p_actor, coalesce(p_meta, '{}'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- contacts
create or replace function public.log_contact_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cols text[];
begin
  if tg_op = 'INSERT' then
    perform public.write_activity(new.user_id, 'contact', new.id, 'created',
      'Created contact ' || new.name, public.activity_actor());
  elsif tg_op = 'UPDATE' then
    cols := public.changed_columns(to_jsonb(old), to_jsonb(new));
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'contact', new.id, 'updated',
        'Updated contact ' || new.name, public.activity_actor(), jsonb_build_object('changed', cols));
    end if;
  else
    perform public.write_activity(old.user_id, 'contact', old.id, 'deleted',
      'Deleted contact ' || old.name, public.activity_actor());
  end if;
  return null;
end;
$$;

create trigger contacts_activity
  after insert or update or delete on public.contacts
  for each row execute function public.log_contact_activity();

-- ----------------------------------------------------------- opportunities
create or replace function public.log_opportunity_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cols text[];
  actor text := public.activity_actor();
begin
  if tg_op = 'INSERT' then
    perform public.write_activity(new.user_id, 'opportunity', new.id, 'created',
      'Created opportunity ' || new.title || ' ($' || to_char(new.value, 'FM999,999,999,990') || ')', actor);
  elsif tg_op = 'UPDATE' then
    if new.stage is distinct from old.stage then
      perform public.write_activity(new.user_id, 'opportunity', new.id, 'stage_changed',
        'Moved ' || new.title || ' from ' || initcap(old.stage) || ' to ' || initcap(new.stage), actor,
        jsonb_build_object('from', old.stage, 'to', new.stage));
    end if;
    cols := array_remove(public.changed_columns(to_jsonb(old), to_jsonb(new)), 'stage');
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'opportunity', new.id, 'updated',
        'Updated opportunity ' || new.title, actor, jsonb_build_object('changed', cols));
    end if;
  else
    perform public.write_activity(old.user_id, 'opportunity', old.id, 'deleted',
      'Deleted opportunity ' || old.title, actor);
  end if;
  return null;
end;
$$;

create trigger opportunities_activity
  after insert or update or delete on public.opportunities
  for each row execute function public.log_opportunity_activity();

-- ------------------------------------------------------------------- tasks
create or replace function public.log_task_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cols text[];
  actor text := public.activity_actor();
begin
  if tg_op = 'INSERT' then
    perform public.write_activity(new.user_id, 'task', new.id, 'created',
      'Created task ' || new.title,
      case when new.source = 'automation' then 'automation' else actor end,
      jsonb_build_object('source', new.source));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.write_activity(new.user_id, 'task', new.id,
        case new.status when 'completed' then 'completed' when 'cancelled' then 'cancelled' else 'reopened' end,
        (case new.status when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' else 'Reopened' end)
          || ' task ' || new.title,
        actor, jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.due_at is distinct from old.due_at then
      perform public.write_activity(new.user_id, 'task', new.id, 'rescheduled',
        'Rescheduled task ' || new.title, actor,
        jsonb_build_object('from', old.due_at, 'to', new.due_at));
    end if;
    cols := array_remove(array_remove(public.changed_columns(to_jsonb(old), to_jsonb(new)), 'status'), 'due_at');
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'task', new.id, 'updated',
        'Updated task ' || new.title, actor, jsonb_build_object('changed', cols));
    end if;
  else
    perform public.write_activity(old.user_id, 'task', old.id, 'deleted',
      'Deleted task ' || old.title, actor);
  end if;
  return null;
end;
$$;

create trigger tasks_activity
  after insert or update or delete on public.tasks
  for each row execute function public.log_task_activity();

-- Trigger/helper functions are internal: not callable through the API.
revoke execute on function
  public.write_activity(uuid, text, uuid, text, text, text, jsonb),
  public.log_contact_activity(),
  public.log_opportunity_activity(),
  public.log_task_activity()
from public, anon, authenticated;
