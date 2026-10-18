create table if not exists public.schedule_reviews (
 user_key text not null check (user_key ~ '^[0-9a-f]{64}$'),
 id text not null check (id ~ '^[0-9a-f]{16}$'),
 created_at timestamptz not null,
 review jsonb not null check (jsonb_typeof(review) = 'object'),
 primary key (user_key,id)
);
create index if not exists schedule_reviews_owner_created on public.schedule_reviews(user_key,created_at desc);
alter table public.schedule_reviews enable row level security;
revoke all on public.schedule_reviews from public,anon,authenticated;
grant select,insert,update,delete on public.schedule_reviews to service_role;
