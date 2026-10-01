-- Readable provider errors (instead of raw JSON) for the email log and the demo panel.

create or replace function public.provider_error_message(p_status int, p_content text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text;
begin
  begin
    m := (p_content::jsonb) ->> 'message';
  exception when others then
    m := null;
  end;
  m := coalesce(nullif(m, ''), left(coalesce(p_content, ''), 300));
  return 'Email provider rejected the request (HTTP ' || coalesce(p_status::text, '?') || '): ' || left(m, 300)
    || case when p_status = 403 and m ilike '%your own email address%'
            then ' Tip: set the test recipient on the Email page to your Resend account email.'
            else '' end;
end;
$$;

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
                  else coalesce(r.error_msg, public.provider_error_message(r.status_code, r.content)) end;
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

revoke execute on function public.provider_error_message(int, text) from public, anon, authenticated;
revoke execute on function public.reconcile_email_log() from public, anon, authenticated;
grant execute on function public.reconcile_email_log() to service_role;
