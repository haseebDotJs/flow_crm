-- FlowCRM initial schema: profiles, contacts, opportunities, tasks + RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile row automatically on signup.
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
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- contacts
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null check (length(btrim(name)) > 0),
  email text,
  phone text,
  company text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- lets child tables prove a contact belongs to the same user
  unique (id, user_id)
);

create index contacts_user_id_idx on public.contacts (user_id);
create index contacts_user_name_idx on public.contacts (user_id, lower(name));

create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------- opportunities
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  contact_id uuid not null,
  title text not null check (length(btrim(title)) > 0),
  value numeric(14, 2) not null default 0 check (value >= 0),
  stage text not null default 'new'
    check (stage in ('new', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- contact must belong to the same user
  foreign key (contact_id, user_id)
    references public.contacts (id, user_id) on delete cascade
);

create index opportunities_user_id_idx on public.opportunities (user_id);
create index opportunities_contact_id_idx on public.opportunities (contact_id);
create index opportunities_user_stage_idx on public.opportunities (user_id, stage);

create trigger opportunities_updated_at before update on public.opportunities
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------- tasks
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  contact_id uuid,
  opportunity_id uuid,
  title text not null check (length(btrim(title)) > 0),
  description text,
  due_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- referenced records must belong to the same user (skipped when the column is null)
  foreign key (contact_id, user_id)
    references public.contacts (id, user_id) on delete set null (contact_id),
  foreign key (opportunity_id, user_id)
    references public.opportunities (id, user_id) on delete set null (opportunity_id)
);

create index tasks_user_due_idx on public.tasks (user_id, due_at);
create index tasks_contact_id_idx on public.tasks (contact_id);
create index tasks_opportunity_id_idx on public.tasks (opportunity_id);

-- Guard against duplicate follow-ups from repeated tool calls.
create unique index tasks_no_duplicate_pending_idx
  on public.tasks (user_id, opportunity_id, title, due_at)
  where status = 'pending' and opportunity_id is not null;

create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.opportunities enable row level security;
alter table public.tasks enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "contacts_all_own" on public.contacts
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "opportunities_all_own" on public.opportunities
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "tasks_all_own" on public.tasks
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Explicit grants: signed-in users only, nothing for anon.
revoke all on public.profiles, public.contacts, public.opportunities, public.tasks from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.contacts, public.opportunities, public.tasks to authenticated;

-- Realtime so the UI can reflect voice-agent changes live.
alter publication supabase_realtime add table public.opportunities, public.tasks, public.contacts;
