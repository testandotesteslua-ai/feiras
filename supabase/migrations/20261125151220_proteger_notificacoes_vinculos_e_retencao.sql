CREATE OR REPLACE FUNCTION public.salvar_push(p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then raise exception 'Entre na sua conta'; end if;
  if p_endpoint is null or length(p_endpoint)>2048 or p_endpoint !~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|notify\.windows\.com)/' or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}$' or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}$' then raise exception 'Inscrição de notificações inválida'; end if;
  insert into public.push_subs(user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, criado_em = now() where public.push_subs.user_id = excluded.user_id;
  if not found then raise exception 'Não foi possível registrar este dispositivo'; end if;
end $function$
;
CREATE OR REPLACE FUNCTION public.remover_push(p_endpoint text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  delete from public.push_subs where endpoint = p_endpoint and user_id = auth.uid();
$function$
;
CREATE OR REPLACE FUNCTION public._vincular_pre(p_pre uuid, p_marca uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.pre_inscricoes; m public.marcas; v_id uuid;
begin
  select * into r from public.pre_inscricoes where id = p_pre for update;
  if r.id is null then raise exception 'Pré-inscrição não encontrada'; end if;
  if r.inscricao_id is not null then
    if exists (select 1 from public.inscricoes where id=r.inscricao_id and marca_id=p_marca) then return r.inscricao_id; end if;
    raise exception 'Pré-inscrição já vinculada';
  end if;
  select * into m from public.marcas where id = p_marca;
  if m.id is null then raise exception 'Marca não encontrada'; end if;
  select id into v_id from public.inscricoes where edicao_id = r.edicao_id and marca_id = m.id;
  if v_id is null then
    insert into public.inscricoes (edicao_id, marca_id, dono, tamanho, dia_unico, status, pago, pago_sinal, valor_pago, ordem_pagamento, ciente_curadoria, criado_em)
    values (r.edicao_id, m.id, m.dono,
      case when (select coalesce(s.sem_metragem,false) from public.segmentos s where s.slug = m.segmento) then 'unico' else r.tamanho end,
      r.dia_unico, 'confirmada', r.pago, r.pago_sinal, r.valor_pago, r.ordem_pagamento, true, r.criado_em)
    returning id into v_id;
  else
    update public.inscricoes set status = 'confirmada', pago = (pago or r.pago), pago_sinal = (pago_sinal or r.pago_sinal),
      valor_pago = coalesce(r.valor_pago, valor_pago), ordem_pagamento = coalesce(r.ordem_pagamento, ordem_pagamento),
      tamanho = case when r.valor_pago is not null and tamanho <> 'unico' then r.tamanho else tamanho end,
      dia_unico = coalesce(r.dia_unico, dia_unico), criado_em = least(criado_em, r.criado_em)
    where id = v_id;
  end if;
  insert into public.decisoes (inscricao_id, decisao) values (v_id, 'confirmada')
    on conflict (inscricao_id) do update set decisao = 'confirmada', atualizado_em = now();
  if r.comprovante_path is not null then
    update public.inscricoes set comprovante_path = coalesce(comprovante_path, r.comprovante_path), comprovante_em = coalesce(comprovante_em, now()) where id = v_id;
  end if;
  update public.pre_inscricoes set inscricao_id = v_id where id = p_pre;
  return v_id;
end $function$
;
CREATE OR REPLACE FUNCTION public.limpar_dados_sensiveis(p_edicao uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if not public.is_membro(public.org_da_edicao(p_edicao)) then raise exception 'Apenas a organização'; end if;
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
revoke execute on function public.salvar_push(text,text,text), public.remover_push(text), public.limpar_dados_sensiveis(uuid) from public, anon;
grant execute on function public.salvar_push(text,text,text), public.remover_push(text), public.limpar_dados_sensiveis(uuid) to authenticated;
revoke execute on function public._vincular_pre(uuid,uuid) from public, anon, authenticated;
