-- Allow short real sessions, including quick hackathon check-ins.
-- The bot uploads whole minutes, with a minimum of one minute.
begin;
alter table public.study_sessions
  drop constraint if exists study_sessions_duration_mins_check;
alter table public.study_sessions
  add constraint study_sessions_duration_mins_check
  check (duration_mins is null or duration_mins between 1 and 1440);
commit;
