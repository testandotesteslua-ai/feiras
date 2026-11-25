grant execute on function public.criar_organizacao(text,text),
  public.resumo_feira(uuid),
  public.link_grupo(uuid),
  public.salvar_roleta_itens(uuid,boolean,jsonb),
  public.trocar_dia(uuid,date)
to authenticated;
