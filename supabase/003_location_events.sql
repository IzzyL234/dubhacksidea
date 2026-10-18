-- An arrival is a location observation, not proof that studying occurred.
create table if not exists public.location_events (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  device_key text not null check (device_key ~ '^[0-9a-f]{64}$'),
  region_name text not null check (char_length(region_name) between 1 and 100),
  event text not null check (event in ('enter', 'leave')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists location_events_device_time
  on public.location_events (device_key, occurred_at desc);
alter table public.location_events enable row level security;
revoke all on public.location_events from anon, authenticated;
grant select, insert on public.location_events to service_role;
