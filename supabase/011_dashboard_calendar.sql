-- Private, short-lived copy of upcoming Hackathon Demo events for connected dashboards.
create table if not exists public.dashboard_calendar (
  user_key text primary key check (user_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('ready','unavailable')),
  synced_at timestamptz,
  events jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array')
);
alter table public.dashboard_calendar enable row level security;
revoke all on public.dashboard_calendar from public, anon, authenticated;
grant select, insert, update, delete on public.dashboard_calendar to service_role;
