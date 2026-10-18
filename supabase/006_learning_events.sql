-- Run after 002_study_feedback.sql and 004_session_lifecycle.sql.
-- Completed, correctly linked real observations only. No synthetic starters.
create or replace view public.study_learning_history with (security_invoker = true) as
select s.user_id, f.id as feedback_id, to_jsonb(s) as session_record, to_jsonb(f) as feedback_record
from public.study_sessions s
join public.study_feedback f on f.session_id=s.id and f.conversation_key=s.user_id and s.feedback_id=f.id
where s.status='completed' and not s.is_synthetic and not f.is_synthetic;
revoke all on public.study_learning_history from public, anon, authenticated;
grant select on public.study_learning_history to service_role;

create table if not exists public.proactivity_events (
 id uuid primary key,
 user_key text not null check(user_key ~ '^[0-9a-f]{64}$'),
 reported_at timestamptz not null,
 action text not null check(action in ('stay_quiet','offer_study','offer_place','accepted','skipped')),
 reason text not null check(reason ~ '^[a-zA-Z0-9_]{1,80}$'),
 occurrence_count integer not null default 1 check(occurrence_count>0),
 place_category text check(place_category in ('library','cafe','home','dorm_room','classroom','campus_building')),
 decision_context jsonb,
 related_decision_id uuid,
 created_at timestamptz not null default now()
);
create index if not exists proactivity_events_user_time on public.proactivity_events(user_key,reported_at);
alter table public.proactivity_events enable row level security;
revoke all on public.proactivity_events from public,anon,authenticated;
grant select,insert,update on public.proactivity_events to service_role;
-- related_decision_id intentionally has no FK: retries may upload an outcome before its decision.
