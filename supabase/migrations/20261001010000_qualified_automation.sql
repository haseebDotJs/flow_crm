-- P1: when an opportunity moves New -> Qualified, create a follow-up task ~2 days out.
-- Tasks created this way are marked source = 'automation' so the Voice AI (or a user) can
-- adopt/retime them instead of creating a duplicate.

alter table public.tasks
  add column source text not null default 'manual'
    check (source in ('manual', 'automation'));

-- At most one pending automation task per opportunity (guards against flip-flopping stages).
create unique index tasks_one_pending_automation_idx
  on public.tasks (opportunity_id)
  where source = 'automation' and status = 'pending';

create or replace function public.create_qualified_follow_up()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  contact_name text;
begin
  -- Only the New -> Qualified transition.
  if old.stage is distinct from 'new' or new.stage is distinct from 'qualified' then
    return new;
  end if;

  -- Respect an existing pending follow-up for this opportunity.
  if exists (
    select 1 from public.tasks
    where opportunity_id = new.id and user_id = new.user_id and status = 'pending'
  ) then
    return new;
  end if;

  select c.name into contact_name
  from public.contacts c
  where c.id = new.contact_id and c.user_id = new.user_id;

  insert into public.tasks (user_id, contact_id, opportunity_id, title, due_at, source)
  values (
    new.user_id,
    new.contact_id,
    new.id,
    'Follow up with ' || coalesce(contact_name, 'contact'),
    now() + interval '2 days',
    'automation'
  )
  on conflict do nothing;

  return new;
end;
$$;

create trigger opportunities_qualified_follow_up
  after update of stage on public.opportunities
  for each row
  when (old.stage = 'new' and new.stage = 'qualified')
  execute function public.create_qualified_follow_up();
