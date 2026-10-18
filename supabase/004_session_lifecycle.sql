-- Preserve existing rows; allow an honest incomplete session at start.
alter table public.study_sessions alter column duration_mins drop not null;
alter table public.study_sessions alter column location drop not null;
alter table public.study_sessions alter column study_space drop not null;
alter table public.study_sessions add column if not exists ended_at timestamptz;
alter table public.study_sessions add column if not exists environment_source text;
alter table public.study_sessions add column if not exists status text not null default 'completed';
alter table public.study_sessions add column if not exists feedback_id uuid;
-- Existing rating columns remain for compatibility. Linked ratings live in study_feedback.
-- New sessions use status='active' explicitly. Old rows are not relabeled as unfinished.
create index if not exists study_sessions_user_started on public.study_sessions(user_id, started_at);
