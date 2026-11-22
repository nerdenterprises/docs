-- Applied 2026-11-22. Let the admin clear a stuck item out of the review panel.
--
-- Before this there was no way to get rid of a needs_review item: the panel offered
-- Retry and Open, so anything that kept scoring under the confidence threshold sat
-- there permanently and Retry just re-rolled the same dice.
--
-- Soft delete on purpose: the row and the Storage object both stay put, so a
-- mistaken trash is recoverable with
--     update public.jobs        set status = 'needs_review' where id = '<job id>';
--     update public.submissions set status = 'queued'       where id = '<submission id>';
-- 'discarded' is inert by construction -- enqueue_run() only picks up submissions
-- with status 'new', and claim_next_job() only claims jobs with status 'queued' --
-- so a discarded file can never be revived by "Process ALL documents".
--
-- SECURITY DEFINER because RLS grants the admin SELECT on jobs but not UPDATE; the
-- email check below is the gate, matching process-enqueue's ADMIN_EMAIL.
create or replace function public.discard_job(p_job_id uuid)
returns table (job_id uuid, original_filename text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sub   uuid;
  v_name  text;
begin
  if v_email <> 'seth@nerdenterprises.com' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select j.submission_id, s.original_filename
    into v_sub, v_name
  from public.jobs j
  join public.submissions s on s.id = j.submission_id
  where j.id = p_job_id
    and j.status in ('needs_review', 'error');

  if v_sub is null then
    raise exception 'job not found, or not in a discardable state'
      using errcode = 'P0002';
  end if;

  update public.jobs        set status = 'discarded' where id = p_job_id;
  update public.submissions set status = 'discarded' where id = v_sub;

  return query select p_job_id, v_name;
end;
$$;

revoke all on function public.discard_job(uuid) from public, anon;
grant execute on function public.discard_job(uuid) to authenticated;
