# ExpoMatch — auditoria de segurança 20/11/2026

Ambiente único: GitHub `testandotesteslua-ai/feiras` e Supabase `plataforma-feiras` (`guiieswqphjixidbtzvs`). Nenhum banco paralelo criado.

## Confirmado por consulta SQL somente leitura
- `public.inscricoes`: UNIQUE (`edicao_id`, `marca_id`) e UNIQUE (`edicao_id`, `vaga_id`), protegendo contra duplicação e atribuição duplicada no banco.
- `public.escolher_vaga`: verifica dono da inscrição, status, pagamento, prazo, mapa, bloqueio e tamanho; captura violação de unicidade.
- `public.inscrever`: exige login, marca própria, logo, ciência de curadoria, valida categorias e perguntas; faz UPSERT limitado a inscrições recebidas.
- `public.organizacoes`: SELECT para anon/authenticated quando `status='ativa'` ou membro; UPDATE para qualquer membro via `is_membro(id)`. Necessária revisão de exposição de colunas e campos de administração antes de restringir, para não quebrar a equipe.
- `public.edicoes` e `public.mapa_vagas`: políticas de leitura e gerenciamento por membros.

## Avisos do Security Advisor (não equivalem a vulnerabilidades exploradas)
- 5 funções SECURITY DEFINER executáveis por `anon`.
- 36 funções SECURITY DEFINER executáveis por `authenticated`.
- Proteção contra senhas vazadas desabilitada.
- 3 tabelas com RLS habilitada e sem políticas (`ia_usos`, `push_config`, `reembolso_auditoria`); isso pode ser intencional.

## Próximas correções, após avaliar dependências
1. Examinar colunas sensíveis de organizações e consumidores do frontend antes de substituir acesso público por uma projeção pública segura.
2. Separar campos editáveis por equipe dos campos restritos à dona, considerando triggers e RPCs existentes.
3. Revisar autorização de cada função SECURITY DEFINER, em vez de revogar EXECUTE indiscriminadamente.
4. Testar os fluxos com contas reais autorizadas e dados identificados de teste dentro da mesma base.
5. Validar pagamentos e termos de cancelamento por edição.

Nenhuma mudança de esquema ou dados foi realizada nesta auditoria. Não há alegação de teste ponta a ponta.