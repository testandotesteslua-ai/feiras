create or replace function public.listar_equipe(p_org uuid)
returns table(user_id uuid,email text,papel text)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and m.papel='dona') then
   raise exception 'Apenas a proprietária pode gerenciar a equipe';
 end if;
 return query select m.user_id,u.email::text,m.papel from public.membros_organizacao m join auth.users u on u.id=m.user_id where m.organizacao_id=p_org order by (m.papel='dona') desc,u.email;
end $$;
create or replace function public.adicionar_equipe(p_org uuid,p_email text)
returns void language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
 if auth.uid() is null or not exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and m.papel='dona') then
   raise exception 'Apenas a proprietária pode gerenciar a equipe';
 end if;
 if p_email is null or length(trim(p_email))>254 then raise exception 'Informe um e-mail válido'; end if;
 select u.id into v_user from auth.users u where lower(u.email)=lower(trim(p_email)) and u.email_confirmed_at is not null;
 if v_user is null then raise exception 'A pessoa precisa criar e confirmar a conta no Colanessa primeiro'; end if;
 insert into public.membros_organizacao(organizacao_id,user_id,papel) values(p_org,v_user,'equipe')
 on conflict(organizacao_id,user_id) do nothing;
end $$;
create or replace function public.remover_equipe(p_org uuid,p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.membros_organizacao m where m.organizacao_id=p_org and m.user_id=auth.uid() and m.papel='dona') then
   raise exception 'Apenas a proprietária pode gerenciar a equipe';
 end if;
 delete from public.membros_organizacao where organizacao_id=p_org and user_id=p_user and papel='equipe';
end $$;
revoke execute on function public.listar_equipe(uuid),public.adicionar_equipe(uuid,text),public.remover_equipe(uuid,uuid) from public,anon;
grant execute on function public.listar_equipe(uuid),public.adicionar_equipe(uuid,text),public.remover_equipe(uuid,uuid) to authenticated;