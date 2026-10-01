-- Fix: a follow-up with no opportunity attached was wrongly rejected with "The contact has no
-- email address", because the check used `not found` after the (optional) opportunity lookup.

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

  -- (Not `not found`: that would refer to the opportunity lookup above, which is legitimately empty
  -- for follow-ups that are not attached to a deal.)
  if c.id is null or nullif(btrim(coalesce(c.email, '')), '') is null then
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

revoke execute on function public.send_task_email(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.send_task_email(uuid, text, boolean) to service_role;
