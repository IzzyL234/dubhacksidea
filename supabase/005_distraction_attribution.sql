-- Run after 002_study_feedback.sql. Existing records remain unchanged.
-- This is the user's attribution, not an established causal effect.
alter table public.study_feedback
  add column if not exists distraction_attribution text
  check (distraction_attribution in ('interruption', 'setup', 'unsure'));
