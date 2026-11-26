create function public.mp_dados_inscricao_teste(p_inscricao uuid, p_dono uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id',i.id,'edicao_id',i.edicao_id,'status',i.status,'isento',i.isento,'pago',i.pago,
    'pago_sinal',i.pago_sinal,'valor_pago',i.valor_pago,'credito_usado',i.credito_usado,
    'tem_comprovante',i.comprovante_path is not null,'tamanho',i.tamanho,'dia_unico',i.dia_unico,
    'valor_combinado',i.valor_combinado,
    'edicoes',jsonb_build_object('organizacao_id',e.organizacao_id,'gratuita',e.gratuita,
      'cancelada_em',e.cancelada_em,'preco_dia',e.preco_dia,'preco_2m',e.preco_2m,
      'preco_3m',e.preco_3m,'preco_unico',e.preco_unico))
  from public.inscricoes i join public.edicoes e on e.id=i.edicao_id
  where i.id=p_inscricao and i.dono=p_dono
$$;
revoke all on function public.mp_dados_inscricao_teste(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mp_dados_inscricao_teste(uuid,uuid) to service_role;