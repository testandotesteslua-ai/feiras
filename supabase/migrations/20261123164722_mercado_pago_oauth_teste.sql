create table public.mp_oauth_tentativas_teste (
  estado_hash text primary key,
  organizacao_id uuid not null unique references public.organizacoes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expira_em timestamptz not null
);
create table public.mp_conexoes_teste (
  organizacao_id uuid primary key references public.organizacoes(id) on delete cascade,
  vendedor_id text not null,
  token_cifrado text not null,
  expira_em timestamptz not null,
  tentativa uuid not null default gen_random_uuid(),
  order_id text,
  checkout_url text,
  check ((order_id is null) = (checkout_url is null))
);
alter table public.mp_oauth_tentativas_teste enable row level security;
alter table public.mp_conexoes_teste enable row level security;
revoke all on public.mp_oauth_tentativas_teste, public.mp_conexoes_teste from public, anon, authenticated;
grant select, insert, update, delete on public.mp_oauth_tentativas_teste to service_role;
grant select, insert, update on public.mp_conexoes_teste to service_role;
