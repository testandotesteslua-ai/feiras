create table if not exists public.pagamentos_mercado_pago_teste (
  inscricao_id uuid primary key references public.inscricoes(id) on delete cascade,
  tentativa uuid not null default gen_random_uuid() unique,
  valor numeric(10,2) not null check (valor > 0),
  order_id text unique,
  checkout_url text,
  confirmado_em timestamptz,
  check ((order_id is null) = (checkout_url is null)),
  check (confirmado_em is null or order_id is not null)
);

alter table public.pagamentos_mercado_pago_teste enable row level security;
revoke all on public.pagamentos_mercado_pago_teste from public, anon, authenticated;
grant select, insert, update on public.pagamentos_mercado_pago_teste to service_role;
