-- 005_user_models_and_photos.sql
-- Stores per-user LinUCB contextual bandit parameters and per-user workspace photo logs in Supabase.

-- 1. Per-user LinUCB Model State & Parameters
create table if not exists public.user_model_params (
  user_id text primary key,
  version integer not null default 1,
  observations_count integer not null default 0,
  inverse_matrix jsonb not null,
  productivity_weights jsonb not null,
  mood_weights jsonb not null,
  theta_productivity jsonb not null,
  theta_mood jsonb not null,
  combination_counts jsonb not null default '{}'::jsonb,
  observed_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_model_params enable row level security;
revoke all on public.user_model_params from anon, authenticated;
grant select, insert, update on public.user_model_params to service_role;

-- 2. Per-user Workspace Photo Analysis Log (Metadata only, no raw image bytes)
create table if not exists public.workspace_photos_log (
  id text primary key,
  user_id text not null,
  session_id text,
  timestamp timestamptz not null default now(),
  duration_mins integer not null default 45,
  location text not null,
  study_space text not null,
  location_class text not null,
  peceptron_tags jsonb not null,
  linucb_metrics jsonb not null,
  user_productivity_rating integer check (user_productivity_rating between 1 and 5),
  user_mood_rating integer check (user_mood_rating between 1 and 5),
  user_distraction_rating integer check (user_distraction_rating between 1 and 5),
  distraction_source text check (distraction_source in ('surroundings', 'phone', 'other')),
  sample_weight numeric default 1.0,
  source text not null default 'perceptron_vlm',
  created_at timestamptz not null default now()
);

create index if not exists workspace_photos_log_user_time
  on public.workspace_photos_log (user_id, timestamp desc);

alter table public.workspace_photos_log enable row level security;
revoke all on public.workspace_photos_log from anon, authenticated;
grant select, insert, update on public.workspace_photos_log to service_role;
