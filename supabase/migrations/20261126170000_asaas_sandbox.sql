create table public.asaas_sandbox_conexoes (
  organizacao_id uuid primary key references public.organizacoes(id) on delete cascade,
  wallet_id uuid not null,
  checkout_id text unique,
  checkout_estado text check (checkout_estado in ('aguardando', 'pago', 'cancelado', 'expirado')),
  tentativa uuid
);
alter table public.asaas_sandbox_conexoes enable row level security;
revoke all on public.asaas_sandbox_conexoes from public, anon, authenticated;
grant select, insert, update on public.asaas_sandbox_conexoes to service_role;
