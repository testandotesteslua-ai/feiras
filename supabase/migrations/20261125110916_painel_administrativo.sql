create or replace function public.painel_administrativo()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  resumo jsonb;
begin
  if not public.is_admin() then
    raise exception 'Só a administração da plataforma pode acessar este painel' using errcode = '42501';
  end if;

  resumo := public.resumo_plataforma();
  return resumo || jsonb_build_object(
    'usuarios', (select count(*) from auth.users where not coalesce(is_anonymous, false)),
    'edicoes', (select count(*) from public.edicoes),
    'edicoes_abertas', (select count(*) from public.edicoes where inscricoes_abertas and cancelada_em is null and coalesce(data_fim,data) >= current_date),
    'inscricoes', (select count(*) from public.inscricoes),
    'confirmadas', (select count(*) from public.inscricoes where status = 'confirmada'),
    'pagas_registradas', (select count(*) from public.inscricoes where pago and not coalesce(isento,false)),
    'valor_registrado', (select coalesce(sum(valor_pago),0) from public.inscricoes where not coalesce(isento,false)),
    'pagamentos_teste', (select count(*) from public.pagamentos_mercado_pago_teste where confirmado_em is not null),
    'organizacoes_detalhes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id,
        'edicoes', (select count(*) from public.edicoes e where e.organizacao_id = o.id),
        'inscricoes', (select count(*) from public.inscricoes i join public.edicoes e on e.id = i.edicao_id where e.organizacao_id = o.id)
      )), '[]'::jsonb) from public.organizacoes o
    ),
    'edicoes_recentes', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.data desc, t.id), '[]'::jsonb)
      from (
        select e.id, e.titulo, e.data, e.inscricoes_abertas, e.cancelada_em is not null as cancelada, o.nome as organizacao,
          (select count(*) from public.inscricoes i where i.edicao_id = e.id) as inscricoes,
          (select count(*) from public.inscricoes i where i.edicao_id = e.id and i.status = 'confirmada') as confirmadas
        from public.edicoes e join public.organizacoes o on o.id = e.organizacao_id
        order by e.data desc, e.id limit 20
      ) t
    )
  );
end;
$$;
revoke all on function public.painel_administrativo() from public, anon, authenticated;
grant execute on function public.painel_administrativo() to authenticated;
