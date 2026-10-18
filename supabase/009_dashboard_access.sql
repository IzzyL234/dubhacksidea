-- Dashboard codes grant read-only access to one chat, expire in 24 hours,
-- and are stored only as SHA-256 hashes. No public table access is granted.
create table if not exists public.dashboard_access (
 user_key text primary key check(user_key ~ '^[0-9a-f]{64}$'),
 token_hash text unique not null check(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table public.dashboard_access enable row level security;
revoke all on public.dashboard_access from public,anon,authenticated;
grant select,insert,update,delete on public.dashboard_access to service_role;
