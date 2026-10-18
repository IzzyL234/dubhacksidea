-- Only user-confirmed tags are stored. Raw free text is deliberately excluded.
create unique index if not exists study_feedback_context_owner
  on public.study_feedback(id, conversation_key, session_id);
create table if not exists public.study_session_context (
  feedback_id uuid primary key,
  session_id text not null,
  conversation_key text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  reported_at timestamptz not null,
  sentiment text not null check (sentiment in ('positive','neutral','negative','mixed','unclear')),
  social text not null check (social in ('alone','with_others','unclear')),
  social_effect text not null check (social_effect in ('helpful','distracting','mixed','unclear')),
  factors text[] not null check (cardinality(factors)<=6 and factors <@ array['social_support','social_interruption','noise','comfort','fatigue','task_difficulty']::text[]),
  created_at timestamptz not null default now(),
  foreign key (feedback_id, conversation_key, session_id)
    references public.study_feedback(id, conversation_key, session_id) on delete cascade
);
create index if not exists study_session_context_owner_reported
  on public.study_session_context(conversation_key, reported_at);
alter table public.study_session_context enable row level security;
revoke all on public.study_session_context from anon, authenticated;
grant select, insert on public.study_session_context to service_role;
