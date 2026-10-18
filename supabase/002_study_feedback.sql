-- Completed check-ins may exist before we know which study session they refer to.
create table if not exists public.study_feedback (
  id uuid primary key,
  conversation_key text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  reported_at timestamptz not null,
  session_id text references public.study_sessions(id),
  productivity_rating integer not null check (productivity_rating between 1 and 5),
  mood_rating integer not null check (mood_rating between 1 and 5),
  distraction_rating integer not null check (distraction_rating between 1 and 5),
  distraction_source text check (distraction_source in ('surroundings', 'phone', 'other')),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  check (distraction_source is null or distraction_rating >= 4)
);
create index if not exists study_feedback_conversation_reported
  on public.study_feedback (conversation_key, reported_at);
alter table public.study_feedback enable row level security;
revoke all on public.study_feedback from anon, authenticated;
grant select, insert, update on public.study_feedback to service_role;
