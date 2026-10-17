-- Single-owner server-side MVP. No browser/anon access or public policies.
create table if not exists public.agent_records (
  id text not null,
  kind text not null check (kind in ('sessions','events','messages','prompts','decisions')),
  body jsonb not null,
  primary key (kind,id)
);
create index if not exists agent_records_kind on public.agent_records(kind);
alter table public.agent_records enable row level security;
revoke all on public.agent_records from anon, authenticated;
grant select, insert, update, delete on public.agent_records to service_role;
