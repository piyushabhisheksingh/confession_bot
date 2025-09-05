-- 1) Extensions (optional but recommended)
create extension if not exists pgcrypto with schema public;

-- 2) Common trigger function for updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

-- 3) public.session (per-user)
create table if not exists public.session (
  id          bigint primary key,
  session     text not null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_session_updated_at_ins on public.session;
create trigger trg_session_updated_at_ins
before insert on public.session
for each row execute function public.set_updated_at();

drop trigger if exists trg_session_updated_at_upd on public.session;
create trigger trg_session_updated_at_upd
before update on public.session
for each row execute function public.set_updated_at();

-- 4) public.config (per-chat)
-- - value: for @grammyjs/storage-supabase (chat-level session store)
-- - config: for custom bot settings (JSON string, e.g. {"threadId": 123})
create table if not exists public.config (
  id          bigint primary key,
  value       text not null default '{}'::text,
  config      text,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_config_updated_at_ins on public.config;
create trigger trg_config_updated_at_ins
before insert on public.config
for each row execute function public.set_updated_at();

drop trigger if exists trg_config_updated_at_upd on public.config;
create trigger trg_config_updated_at_upd
before update on public.config
for each row execute function public.set_updated_at();

create index if not exists idx_session_updated_at on public.session (updated_at desc);
create index if not exists idx_config_updated_at on public.config (updated_at desc);

-- 6) Post -> User mapping (for fast reply routing)
create table if not exists public.post_user_map (
  post_id     bigint primary key,
  user_id     bigint not null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_post_user_map_updated_at_ins on public.post_user_map;
create trigger trg_post_user_map_updated_at_ins
before insert on public.post_user_map
for each row execute function public.set_updated_at();

drop trigger if exists trg_post_user_map_updated_at_upd on public.post_user_map;
create trigger trg_post_user_map_updated_at_upd
before update on public.post_user_map
for each row execute function public.set_updated_at();

create index if not exists idx_post_user_map_updated_at on public.post_user_map (updated_at desc);

-- 7) Convenience view for broadcasting (optional)
create or replace view public.config_chat_ids as
select id::bigint as chat_id
from public.config;

-- 8) RLS (choose one)
-- Recommended for server-only bots (service role):
alter table public.session disable row level security;
alter table public.config disable row level security;

-- If enabling RLS instead, uncomment and tailor below:
-- alter table public.session enable row level security;
-- alter table public.config enable row level security;
-- create policy session_service_rw on public.session
--   for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
-- create policy config_service_rw on public.config
--   for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 9) Seeds (optional examples)
-- insert into public.session (id, session)
-- values (123456789, '{"confessionTime":0,"confessions":[],"isBanned":false,"freeConfessions":0,"refby":0}')
-- on conflict (id) do update set session = excluded.session;

-- insert into public.config (id, config)
-- values (-1001234567890, '{"threadId": 1}')
-- on conflict (id) do update set config = excluded.config;

-- insert into public.config (id, value)
-- values (-1001234567890, '{"isLogged": false}')
-- on conflict (id) do update set value = excluded.value;
