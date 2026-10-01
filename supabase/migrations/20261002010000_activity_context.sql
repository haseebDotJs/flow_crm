-- Richer activity entries: store the entity's title and its contact/company/opportunity names in
-- metadata at write time, so the UI can show "what" and "who" clearly (and still can after the
-- records are deleted). Summaries are unchanged.

create or replace function public.contact_context(cid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_strip_nulls(jsonb_build_object('contact', c.name, 'company', c.company))
     from public.contacts c where c.id = cid),
    '{}'::jsonb);
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
      'Created contact ' || new.name, public.activity_actor(),
      jsonb_strip_nulls(jsonb_build_object('title', new.name, 'company', new.company)));
  elsif tg_op = 'UPDATE' then
    cols := public.changed_columns(to_jsonb(old), to_jsonb(new));
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'contact', new.id, 'updated',
        'Updated contact ' || new.name, public.activity_actor(),
        jsonb_strip_nulls(jsonb_build_object('title', new.name, 'company', new.company, 'changed', cols)));
    end if;
  else
    perform public.write_activity(old.user_id, 'contact', old.id, 'deleted',
      'Deleted contact ' || old.name, public.activity_actor(),
      jsonb_strip_nulls(jsonb_build_object('title', old.name, 'company', old.company)));
  end if;
  return null;
end;
$$;

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
  ctx jsonb;
begin
  if tg_op = 'INSERT' then
    ctx := jsonb_build_object('title', new.title, 'value', new.value) || public.contact_context(new.contact_id);
    perform public.write_activity(new.user_id, 'opportunity', new.id, 'created',
      'Created opportunity ' || new.title || ' ($' || to_char(new.value, 'FM999,999,999,990') || ')', actor, ctx);
  elsif tg_op = 'UPDATE' then
    ctx := jsonb_build_object('title', new.title, 'value', new.value) || public.contact_context(new.contact_id);
    if new.stage is distinct from old.stage then
      perform public.write_activity(new.user_id, 'opportunity', new.id, 'stage_changed',
        'Moved ' || new.title || ' from ' || initcap(old.stage) || ' to ' || initcap(new.stage), actor,
        ctx || jsonb_build_object('from', old.stage, 'to', new.stage));
    end if;
    cols := array_remove(public.changed_columns(to_jsonb(old), to_jsonb(new)), 'stage');
    if array_length(cols, 1) is not null then
      perform public.write_activity(new.user_id, 'opportunity', new.id, 'updated',
        'Updated opportunity ' || new.title, actor, ctx || jsonb_build_object('changed', cols));
    end if;
  else
    ctx := jsonb_build_object('title', old.title, 'value', old.value) || public.contact_context(old.contact_id);
    perform public.write_activity(old.user_id, 'opportunity', old.id, 'deleted',
      'Deleted opportunity ' || old.title, actor, ctx);
  end if;
  return null;
end;
$$;

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
    cols := array_remove(array_remove(public.changed_columns(to_jsonb(old), to_jsonb(new)), 'status'), 'due_at');
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

revoke execute on function
  public.contact_context(uuid),
  public.log_contact_activity(),
  public.log_opportunity_activity(),
  public.log_task_activity()
from public, anon, authenticated;
