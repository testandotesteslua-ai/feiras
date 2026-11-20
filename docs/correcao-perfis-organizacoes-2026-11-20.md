# Correção — organizações ausentes no seletor de perfis (20/11/2026)

## Sintoma
No modal **Trocar de perfil**, a conta proprietária visualizava apenas expositor e administração, sem as organizações Feira A e Feira B.

## Diagnóstico confirmado
- `public.organizacoes` continha Feira A e Feira B, ambas ativas, cada uma com membro proprietária vinculada à conta afetada.
- O frontend (`index.html`) chama `sb.rpc('minhas_organizacoes')` em `carregarUsuario()` e usa `og.data||[]`, descartando silenciosamente o erro da RPC.
- A função `public.minhas_organizacoes()` filtra `m.user_id=auth.uid()`, mas `authenticated` não tinha privilégio EXECUTE.

## Correção aplicada diretamente no Supabase existente
```sql
grant execute on function public.minhas_organizacoes() to authenticated;
```

## Verificação
Consulta `has_function_privilege` após o GRANT: `authenticated=true`, `anon=false`. Nenhuma tabela, conta ou organização foi alterada. Não foi criado outro ambiente.

## Teste de interface pendente
Recarregar a página autenticada (Ctrl+F5) e abrir **Trocar de perfil**; Feira A e Feira B devem reaparecer. Ainda não foi executado teste autenticado em navegador.

## Melhoria futura
Exibir aviso de erro quando `sb.rpc('minhas_organizacoes')` falhar, em vez de apresentar lista vazia como se não houvesse organizações.
