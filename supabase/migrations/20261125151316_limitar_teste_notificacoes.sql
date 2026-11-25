create table public.push_teste_limite (user_id uuid primary key references auth.users(id) on delete cascade, ultimo_teste timestamptz not null);
alter table public.push_teste_limite enable row level security;
revoke all on public.push_teste_limite from public,anon,authenticated;
create or replace function public.testar_push() returns void language plpgsql security definer set search_path='' as $$
declare c public.push_config;
begin
 if auth.uid() is null then raise exception 'Entre na sua conta'; end if;
 select * into c from public.push_config where id=1;
 if c.function_url is null or c.hook_secret is null then raise exception 'Notificações ainda não configuradas'; end if;
 if not exists(select 1 from public.push_subs where user_id=auth.uid()) then raise exception 'Ative as notificações primeiro'; end if;
 insert into public.push_teste_limite(user_id,ultimo_teste) values(auth.uid(),now())
 on conflict(user_id) do update set ultimo_teste=excluded.ultimo_teste where public.push_teste_limite.ultimo_teste < now()-interval '1 minute';
 if not found then raise exception 'Aguarde um minuto para testar novamente'; end if;
 perform net.http_post(url:=c.function_url,body:=jsonb_build_object('tipo','teste','teste_user',auth.uid()),headers:=jsonb_build_object('Content-Type','application/json','x-hook',c.hook_secret),timeout_milliseconds:=8000);
end $$;
revoke execute on function public.testar_push() from public,anon;
grant execute on function public.testar_push() to authenticated;