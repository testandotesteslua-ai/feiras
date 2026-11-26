create table public.mp_planos_teste (
 organizacao_id uuid primary key references public.organizacoes(id) on delete cascade,
 plano text not null check (plano in ('avulso','gestao','essencial','pro')),
 repassar boolean not null default false,
 primeira_edicao_id uuid references public.edicoes(id)
);
create table public.mp_inscricoes_checkout_teste (
 inscricao_id uuid primary key references public.inscricoes(id) on delete cascade,
 organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
 referencia uuid not null unique default gen_random_uuid(),
 vendedor_id text not null,
 plano text not null check (plano in ('avulso','essencial','pro')),
 base_centavos integer not null check (base_centavos > 0),
 comissao_centavos integer not null check (comissao_centavos between 0 and 500),
 total_centavos integer not null check (total_centavos in (base_centavos, base_centavos + comissao_centavos)),
 preferencia_id text unique,
 checkout_url text,
 pagamento_id text unique,
 aprovado_em timestamptz
);
alter table public.mp_planos_teste enable row level security;
alter table public.mp_inscricoes_checkout_teste enable row level security;
revoke all on public.mp_planos_teste, public.mp_inscricoes_checkout_teste from public, anon, authenticated;
grant select, insert, update, delete on public.mp_planos_teste, public.mp_inscricoes_checkout_teste to service_role;