create or replace function public.auto_vincular_pre() returns trigger language plpgsql security definer set search_path='' as $$ begin return new; end $$;
create or replace function public.marcas_para_vincular(p_edicao uuid) returns table(id uuid,nome text) language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.is_membro(public.org_da_edicao(p_edicao)),false) then raise exception 'Apenas a organização'; end if;
 return query select m.id,m.nome from public.marcas m where exists (select 1 from public.pre_inscricoes p where p.edicao_id=p_edicao and p.inscricao_id is null and public.norm_nome(p.nome)=public.norm_nome(m.nome)) order by m.nome;
end $$;
create or replace function public.vincular_pre(p_pre uuid,p_marca uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.pre_inscricoes;
begin
 select * into r from public.pre_inscricoes where id=p_pre for update;
 if auth.uid() is null or r.id is null or not coalesce(public.is_membro(public.org_da_edicao(r.edicao_id)),false) then raise exception 'Só a organização pode vincular'; end if;
 if not exists (select 1 from public.marcas m where m.id=p_marca and public.norm_nome(m.nome)=public.norm_nome(r.nome)) then raise exception 'Confira o nome cadastrado da marca antes de vincular'; end if;
 return public._vincular_pre(p_pre,p_marca);
end $$;
revoke execute on function public.auto_vincular_pre() from public,anon,authenticated;
revoke execute on function public.marcas_para_vincular(uuid),public.vincular_pre(uuid,uuid) from public,anon;
grant execute on function public.marcas_para_vincular(uuid),public.vincular_pre(uuid,uuid) to authenticated;