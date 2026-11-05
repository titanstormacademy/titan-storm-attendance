create or replace function public.remove_enrollment(p_enrollment_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch bigint;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  select branch_id into v_branch from public.enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'Enrollment not found'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Branch access denied'; end if;
  delete from public.enrollments where id = p_enrollment_id;
end;
$$;

revoke all on function public.remove_enrollment(bigint) from public, anon;
grant execute on function public.remove_enrollment(bigint) to authenticated;
