revoke all on public.push_config from anon,authenticated;
grant select on public.push_config to service_role;
grant update(vapid_public,vapid_private) on public.push_config to service_role;
grant select,delete on public.push_subs to service_role;
create or replace function public.push_destinatarios(p_tipo text,p_ins uuid,p_ed uuid)
returns table(user_id uuid)
language sql stable security definer set search_path='' as $$
 select distinct x.user_id from (
   select m.user_id from public.membros_organizacao m join public.edicoes e on e.organizacao_id=m.organizacao_id where e.id=p_ed and p_tipo in ('nova','comprovante','reembolso')
   union
   select i.dono from public.inscricoes i where i.edicao_id=p_ed and i.id=p_ins and p_tipo in ('confirmada','mapa','vaga')
   union
   select i.dono from public.inscricoes i where i.edicao_id=p_ed and p_tipo='cancelada'
   union
   select i.dono from public.inscricoes i join public.edicoes anterior on anterior.id=i.edicao_id join public.edicoes atual on atual.organizacao_id=anterior.organizacao_id where atual.id=p_ed and p_tipo in ('edicao_nova','abertura') and i.status='confirmada'
 ) x where x.user_id is not null;
$$;
revoke execute on function public.push_destinatarios(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.push_destinatarios(text,uuid,uuid) to service_role;
revoke execute on function public.push_evento(text,uuid,uuid) from public,anon,authenticated;
insert into public.push_config(id,hook_secret) values(1,gen_random_uuid()::text||gen_random_uuid()::text) on conflict(id) do nothing;