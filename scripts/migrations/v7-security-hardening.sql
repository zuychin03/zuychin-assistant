-- Sign out everywhere (V7 security hardening). Apply manually; safe to re-run.
-- One row: a session cookie issued before valid_after is refused. No row cancels nothing.
begin;

create table if not exists public.auth_session_epoch (
  id boolean primary key default true check (id),
  valid_after timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.auth_session_epoch enable row level security;
revoke all on public.auth_session_epoch from public, anon, authenticated;
grant select, insert, update on public.auth_session_epoch to service_role;

notify pgrst, 'reload schema';

commit;
