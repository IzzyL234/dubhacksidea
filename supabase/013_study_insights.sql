create table if not exists public.study_insights (
 user_key text primary key check (user_key ~ '^[0-9a-f]{64}$'),
 generated_at timestamptz not null,
 report jsonb not null check (jsonb_typeof(report) = 'object')
);
alter table public.study_insights enable row level security;
revoke all on public.study_insights from public,anon,authenticated;
grant select,insert,update,delete on public.study_insights to service_role;
