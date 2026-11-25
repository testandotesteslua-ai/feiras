alter table public.membros_organizacao add column pode_editar_dados boolean not null default false, add column pode_limpar_dados boolean not null default false;
create or replace function public.equipe_pode(p_org uuid,p_permissao text)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and p_permissao in ('editar_dados','limpeza_dados') and
 (public.is_admin() or exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and (m.papel='dona' or (m.papel='equipe' and case p_permissao when 'editar_dados' then m.pode_editar_dados when 'limpeza_dados' then m.pode_limpar_dados else false end))));
$$;
revoke execute on function public.equipe_pode(uuid,text) from public,anon;
grant execute on function public.equipe_pode(uuid,text) to authenticated;
create or replace function public.listar_equipe_detalhes(p_org uuid)
returns table(user_id uuid,email text,papel text,pode_editar_dados boolean,pode_limpar_dados boolean)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and m.papel='dona') then raise exception 'Apenas a proprietária pode gerenciar a equipe'; end if;
 return query select m.user_id,u.email::text,m.papel,m.pode_editar_dados,m.pode_limpar_dados from public.membros_organizacao m join auth.users u on u.id=m.user_id where m.organizacao_id=p_org order by (m.papel='dona') desc,u.email;
end $$;
create or replace function public.salvar_permissoes_equipe(p_org uuid,p_user uuid,p_editar boolean,p_limpar boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and m.papel='dona') then raise exception 'Apenas a proprietária pode gerenciar a equipe'; end if;
 update public.membros_organizacao set pode_editar_dados=coalesce(p_editar,false),pode_limpar_dados=coalesce(p_limpar,false) where organizacao_id=p_org and user_id=p_user and papel='equipe';
 if not found then raise exception 'Colaborador não encontrado'; end if;
end $$;
revoke execute on function public.listar_equipe_detalhes(uuid),public.salvar_permissoes_equipe(uuid,uuid,boolean,boolean) from public,anon;
grant execute on function public.listar_equipe_detalhes(uuid),public.salvar_permissoes_equipe(uuid,uuid,boolean,boolean) to authenticated;
alter policy "orgs: equipe edita" on public.organizacoes using (public.equipe_pode(id,'editar_dados')) with check (public.equipe_pode(id,'editar_dados'));
CREATE OR REPLACE FUNCTION public.limpar_dados_sensiveis(p_edicao uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if not public.equipe_pode(public.org_da_edicao(p_edicao),'limpeza_dados') then raise exception 'Apenas a organização'; end if;
  if not exists (select 1 from public.edicoes where id=p_edicao and coalesce(data_fim,data) < (now() at time zone 'America/Sao_Paulo')::date) then raise exception 'Disponível após o encerramento da edição'; end if;
  update public.montadores m set cpf = '' from public.inscricoes i
    where m.inscricao_id = i.id and i.edicao_id = p_edicao
      and not exists (select 1 from public.montagem mo where mo.inscricao_id = i.id and mo.guardar_dados);
  get diagnostics n = row_count;
  update public.montagem mo set placa = null from public.inscricoes i
    where mo.inscricao_id = i.id and i.edicao_id = p_edicao and not mo.guardar_dados;
  return n;
end $function$
;