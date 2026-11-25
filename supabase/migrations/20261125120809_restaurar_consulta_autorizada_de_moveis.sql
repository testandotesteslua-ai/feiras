create or replace function public.moveis_disponiveis(p_edicao uuid, p_excluir uuid default null)
returns table(mesas_total integer, cadeiras_total integer, mesas_usadas integer, cadeiras_usadas integer)
language sql stable security definer set search_path = ''
as $$
  select e.mesas_total, e.cadeiras_total,
    coalesce(sum(m.mesas),0)::int,
    coalesce(sum(m.cadeiras),0)::int
  from public.edicoes e
  left join public.inscricoes i on i.edicao_id = e.id
    and i.status = 'confirmada' and (i.pago or i.pago_sinal)
    and not coalesce(i.id = p_excluir and (i.dono = auth.uid() or public.is_membro(e.organizacao_id)), false)
  left join public.montagem m on m.inscricao_id = i.id
  where e.id = p_edicao and auth.uid() is not null
    and (public.org_ativa(e.organizacao_id) or public.is_membro(e.organizacao_id)
         or exists (select 1 from public.inscricoes propria where propria.edicao_id=e.id and propria.dono=auth.uid()))
  group by e.id,e.mesas_total,e.cadeiras_total;
$$;
revoke all on function public.moveis_disponiveis(uuid,uuid) from public, anon;
grant execute on function public.moveis_disponiveis(uuid,uuid) to authenticated;
