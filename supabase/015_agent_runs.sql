-- Tool receipts only. No chat text, private links, credentials, or coordinates.
create table if not exists public.agent_runs (
 id uuid primary key,
 user_key text not null check (user_key ~ '^[0-9a-f]{64}$'),
 reported_at timestamptz not null,
 outcome text not null check (length(outcome) between 1 and 40),
 steps jsonb not null check (jsonb_typeof(steps)='array' and jsonb_array_length(steps)<=4),
 created_at timestamptz not null default now()
);
create index if not exists agent_runs_owner_time on public.agent_runs(user_key,reported_at desc);
alter table public.agent_runs enable row level security;
revoke all on public.agent_runs from anon,authenticated;
grant select,insert on public.agent_runs to service_role;
