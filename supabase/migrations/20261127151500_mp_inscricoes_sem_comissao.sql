create table public.mp_checkout_inscricoes (
  inscricao_id uuid primary key references public.inscricoes(id) on delete cascade,
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  referencia uuid not null unique default gen_random_uuid(),
  vendedor_id text not null check (vendedor_id ~ '^[0-9]+$'),
  total_centavos integer not null check (total_centavos > 0),
  criado_em timestamptz not null default now(),
  preferencia_id text unique,
  checkout_url text,
  pagamento_id text unique,
  situacao text not null default 'novo'
    check (situacao in ('novo', 'pendente', 'recusado', 'cancelado', 'confirmado', 'revisao')),
  aprovado_em timestamptz,
  duplicado_id text,
  check ((preferencia_id is null) = (checkout_url is null)),
  check (situacao <> 'confirmado' or (pagamento_id is not null and aprovado_em is not null))
);

alter table public.mp_checkout_inscricoes enable row level security;
revoke all on public.mp_checkout_inscricoes from public, anon, authenticated;
grant select, insert, update, delete on public.mp_checkout_inscricoes to service_role;

create function public.mp_registrar_pagamento_inscricao(
  p_referencia uuid, p_pagamento text, p_vendedor text, p_centavos integer,
  p_moeda text, p_teste boolean, p_status text
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  c public.mp_checkout_inscricoes;
  i public.inscricoes;
  e public.edicoes;
  valor numeric;
  nova_situacao text;
begin
  if p_moeda is distinct from 'BRL' or p_teste is distinct from true
    or p_pagamento is null or p_pagamento !~ '^[0-9]{1,30}$' then return 'ignorado'; end if;

  select * into c from public.mp_checkout_inscricoes where referencia = p_referencia for update;
  if not found or c.preferencia_id is null or c.vendedor_id is distinct from p_vendedor
    or c.total_centavos is distinct from p_centavos then return 'ignorado'; end if;

  if c.situacao in ('confirmado', 'revisao') then
    if p_status = 'approved' and c.pagamento_id is distinct from p_pagamento then
      update public.mp_checkout_inscricoes set duplicado_id = coalesce(duplicado_id,p_pagamento)
        where inscricao_id = c.inscricao_id;
      return 'duplicado';
    end if;
    return c.situacao;
  end if;

  if p_status is distinct from 'approved' then
    nova_situacao := case
      when p_status in ('pending', 'authorized', 'in_process', 'in_mediation') then 'pendente'
      when p_status = 'rejected' then 'recusado'
      when p_status in ('cancelled', 'refunded', 'charged_back') then 'cancelado'
    end;
    if nova_situacao is null then return 'ignorado'; end if;
    -- A failure from a different attempt cannot unlock a checkout with a pending payment.
    if c.situacao = 'pendente' and c.pagamento_id is distinct from p_pagamento then return 'pendente'; end if;
    update public.mp_checkout_inscricoes set situacao = nova_situacao, pagamento_id = p_pagamento
      where inscricao_id = c.inscricao_id;
    return nova_situacao;
  end if;

  -- Use the same edition-before-inscription lock order as edition cancellation.
  select ed.* into e from public.edicoes ed
    join public.inscricoes ins on ins.edicao_id = ed.id
    where ins.id = c.inscricao_id for share of ed;
  select * into i from public.inscricoes where id = c.inscricao_id for update;
  valor := coalesce(i.valor_combinado, case
    when i.dia_unico is not null and e.preco_dia is not null then e.preco_dia
    when i.tamanho = 'unico' then e.preco_unico
    when i.tamanho = '3m' then e.preco_3m
    else e.preco_2m end);
  if i.edicao_id is distinct from e.id or e.organizacao_id is distinct from c.organizacao_id
    or not exists (select 1 from public.organizacoes where id = c.organizacao_id and status = 'ativa')
    or i.status is distinct from 'confirmada' or e.cancelada_em is not null
    or coalesce(e.gratuita,false) or coalesce(i.isento,false) or coalesce(i.pago,false)
    or coalesce(i.pago_sinal,false) or coalesce(i.valor_pago,0) > 0
    or coalesce(i.credito_usado,0) > 0 or i.comprovante_path is not null
    or round(valor * 100) is distinct from c.total_centavos then
    update public.mp_checkout_inscricoes set situacao = 'revisao', pagamento_id = p_pagamento, aprovado_em = now()
      where inscricao_id = c.inscricao_id;
    return 'revisao';
  end if;

  update public.inscricoes set pago = true, valor_pago = p_centavos / 100.0 where id = i.id;
  update public.mp_checkout_inscricoes set situacao = 'confirmado', pagamento_id = p_pagamento, aprovado_em = now()
    where inscricao_id = c.inscricao_id;
  return 'confirmado';
end
$$;
revoke all on function public.mp_registrar_pagamento_inscricao(uuid,text,text,integer,text,boolean,text)
  from public, anon, authenticated;
grant execute on function public.mp_registrar_pagamento_inscricao(uuid,text,text,integer,text,boolean,text) to service_role;
