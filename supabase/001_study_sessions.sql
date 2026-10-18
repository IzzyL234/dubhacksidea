-- Matches the table setup used during the demo; no public access policies.
create table if not exists public.study_sessions (
  id text primary key,
  user_id text not null,
  started_at timestamptz not null,
  duration_mins integer not null check (duration_mins between 5 and 240),
  location text not null,
  study_space text not null,
  environment jsonb not null,
  productivity_rating integer check (productivity_rating between 1 and 5),
  mood_rating integer check (mood_rating between 1 and 5),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.study_sessions enable row level security;
revoke all on public.study_sessions from anon, authenticated;
grant select, insert, update on public.study_sessions to service_role;
