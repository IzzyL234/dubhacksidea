-- Additive: existing sessions stay unknown. Run after 004_session_lifecycle.sql.
alter table public.study_sessions
 add column if not exists starting_energy integer check(starting_energy between 1 and 5),
 add column if not exists starting_noise text check(starting_noise in ('quiet','moderate','loud','unknown')),
 add column if not exists starting_context_at timestamptz;
-- 006's to_jsonb(s) history includes these fields without changing the view.
-- Collection only: no fabricated backfill and no change to the 13-feature learner.
