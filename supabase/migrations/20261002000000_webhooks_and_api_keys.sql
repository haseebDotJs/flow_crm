-- Integrations:
--  * Outbound webhook: signed POST to the user's URL when an opportunity changes stage
--    (sent by Postgres via pg_net, so it fires no matter who made the change).
--  * Inbound lead API: API-key-protected function that creates a contact + opportunity.

create extension if not exists pg_net;

-- ------------------------------------------------------- activity: new actor
alter table public.activity_log drop constraint activity_log_actor_check;
alter table public.activity_log
  add constraint activity_log_actor_check check (actor in ('user', 'voice', 'automation', 'webhook'));

-- `webhook` is set inside ingest_lead() via a transaction-local setting (not spoofable by
-- clients); `voice` still comes from the agent's request header.
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
  if v = 'webhook' then
    return 'webhook';
  end if;
  begin
    v := current_setting('request.headers', true)::json ->> 'x-flowcrm-actor';
  exception when others then
    v := null;
  end;
  return case when v = 'voice' then 'voice' else 'user' end;
end;
$$;

-- --------------------------------------------------------- outbound webhooks
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade default auth.uid(),
  url text not null
    check (length(url) <= 2000)
    -- https only, plain hostnames only (no userinfo / IP-literal tricks), no loopback/private ranges
    check (url ~* '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(/.*)?$')
    check (url !~* '^https://(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'),
  secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  events text[] not null default array['opportunity.stage_changed']
    check (events <@ array['opportunity.stage_changed']),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger webhook_endpoints_updated_at before update on public.webhook_endpoints
  for each row execute function public.set_updated_at();

create table public.webhook_deliveries (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint_id uuid references public.webhook_endpoints (id) on delete set null,
  event text not null,
  payload jsonb not null,
  request_id bigint, -- pg_net request id (response lives in net._http_response)
  created_at timestamptz not null default now()
);
create index webhook_deliveries_user_created_idx on public.webhook_deliveries (user_id, created_at desc);

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy "webhook_endpoints_all_own" on public.webhook_endpoints
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "webhook_deliveries_select_own" on public.webhook_deliveries
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;
grant select, insert, update, delete on public.webhook_endpoints to authenticated;
grant select on public.webhook_deliveries to authenticated;

-- Sends the signed event. Signature = HMAC-SHA256(secret, "<timestamp>.<raw body>").
-- A failing webhook must never block the CRM write, so all errors are swallowed.
create or replace function public.enqueue_stage_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ep record;
  c record;
  did uuid;
  payload jsonb;
  body text;
  ts bigint;
  sig text;
  rid bigint;
begin
  for ep in
    select * from public.webhook_endpoints
    where user_id = new.user_id and enabled and 'opportunity.stage_changed' = any (events)
  loop
    begin
      select id, name, email, phone, company into c
      from public.contacts where id = new.contact_id and user_id = new.user_id;

      did := gen_random_uuid();
      payload := jsonb_build_object(
        'id', did,
        'event', 'opportunity.stage_changed',
        'created_at', now(),
        'data', jsonb_build_object(
          'opportunity', jsonb_build_object(
            'id', new.id, 'title', new.title, 'value', new.value,
            'stage', new.stage, 'previous_stage', old.stage),
          'contact', jsonb_build_object(
            'id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'company', c.company)
        )
      );
      body := payload::text;
      ts := extract(epoch from now())::bigint;
      sig := encode(extensions.hmac(ts::text || '.' || body, ep.secret, 'sha256'), 'hex');

      rid := net.http_post(
        url := ep.url,
        body := payload,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'User-Agent', 'FlowCRM-Webhooks/1.0',
          'X-FlowCRM-Event', 'opportunity.stage_changed',
          'X-FlowCRM-Delivery', did::text,
          'X-FlowCRM-Timestamp', ts::text,
          'X-FlowCRM-Signature', 'sha256=' || sig
        ),
        timeout_milliseconds := 5000
      );

      insert into public.webhook_deliveries (id, user_id, endpoint_id, event, payload, request_id)
      values (did, new.user_id, ep.id, 'opportunity.stage_changed', payload, rid);
    exception when others then
      raise warning 'webhook enqueue failed: %', sqlerrm;
    end;
  end loop;
  return null;
end;
$$;

create trigger opportunities_stage_webhooks
  after update of stage on public.opportunities
  for each row
  when (old.stage is distinct from new.stage)
  execute function public.enqueue_stage_webhooks();

-- Delivery log with the HTTP result from pg_net (owner-scoped).
create or replace function public.list_webhook_deliveries(p_limit int default 20)
returns table (
  id uuid,
  event text,
  created_at timestamptz,
  url text,
  status_code int,
  error text,
  response_body text
)
language sql
security definer
stable
set search_path = ''
as $$
  select d.id, d.event, d.created_at, e.url, r.status_code, r.error_msg, left(r.content, 4000)
  from public.webhook_deliveries d
  left join public.webhook_endpoints e on e.id = d.endpoint_id
  left join net._http_response r on r.id = d.request_id
  where d.user_id = (select auth.uid())
  order by d.created_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

-- ---------------------------------------------------------- inbound lead API
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  key_prefix text not null,
  key_hash text not null unique, -- SHA-256 of the key; the plaintext is shown once and never stored
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_user_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;
create policy "api_keys_all_own" on public.api_keys
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.api_keys from anon, authenticated;
-- The hash is never readable through the API.
grant select (id, user_id, name, key_prefix, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant insert (user_id, name, key_prefix, key_hash) on public.api_keys to authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

-- Creates (or reuses, by email) a contact and a new opportunity for the key's owner.
-- Callable without a session: the API key is the credential. Always returns JSON.
create or replace function public.ingest_lead(p_key text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k record;
  uid uuid;
  v_name text := nullif(btrim(coalesce(p_payload ->> 'name', '')), '');
  v_email text := nullif(btrim(coalesce(p_payload ->> 'email', '')), '');
  v_phone text := nullif(btrim(coalesce(p_payload ->> 'phone', '')), '');
  v_company text := nullif(btrim(coalesce(p_payload ->> 'company', '')), '');
  v_notes text := nullif(btrim(coalesce(p_payload ->> 'notes', '')), '');
  v_title text := nullif(btrim(coalesce(p_payload ->> 'opportunity_title', '')), '');
  v_value numeric := 0;
  cid uuid;
  oid uuid;
  created_contact boolean := false;
begin
  if p_key is null or length(p_key) < 20 or length(p_key) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_api_key');
  end if;

  select id, user_id into k
  from public.api_keys
  where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') and revoked_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_api_key');
  end if;
  uid := k.user_id;

  update public.api_keys set last_used_at = now() where id = k.id;

  -- Basic abuse guard: each lead writes ~2 log rows, so cap at ~50 leads / minute / user.
  if (select count(*) from public.activity_log
      where user_id = uid and actor = 'webhook' and created_at > now() - interval '1 minute') >= 100 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Validation
  if jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'Body must be a JSON object.');
  end if;
  if v_name is null or length(v_name) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'name is required (max 200 chars).');
  end if;
  if v_email is not null and (length(v_email) > 200 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'email is not valid.');
  end if;
  if coalesce(length(v_phone), 0) > 50 or coalesce(length(v_company), 0) > 200
     or coalesce(length(v_notes), 0) > 2000 or coalesce(length(v_title), 0) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'A field is too long.');
  end if;
  if p_payload ? 'value' and p_payload ->> 'value' is not null then
    begin
      v_value := (p_payload ->> 'value')::numeric;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'value must be a number.');
    end;
    if v_value < 0 or v_value > 1000000000000 then
      return jsonb_build_object('ok', false, 'error', 'invalid_payload', 'message', 'value is out of range.');
    end if;
  end if;

  perform set_config('flowcrm.actor', 'webhook', true); -- transaction-local

  if v_email is not null then
    select id into cid from public.contacts where user_id = uid and lower(email) = lower(v_email) limit 1;
  end if;
  if cid is null then
    insert into public.contacts (user_id, name, email, phone, company, notes)
    values (uid, v_name, v_email, v_phone, v_company, v_notes)
    returning id into cid;
    created_contact := true;
  end if;

  insert into public.opportunities (user_id, contact_id, title, value, stage, notes)
  values (uid, cid, coalesce(v_title, coalesce(v_company, v_name) || ' - Inbound lead'), v_value, 'new', v_notes)
  returning id into oid;

  return jsonb_build_object('ok', true, 'contact_id', cid, 'opportunity_id', oid, 'created_contact', created_contact);
end;
$$;

-- Internal functions are not callable by clients; the two public entry points are granted explicitly.
revoke execute on function
  public.enqueue_stage_webhooks(),
  public.ingest_lead(text, jsonb),
  public.list_webhook_deliveries(int)
from public, anon, authenticated;
grant execute on function public.ingest_lead(text, jsonb) to anon, authenticated;
grant execute on function public.list_webhook_deliveries(int) to authenticated;
