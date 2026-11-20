# Plano de estabilização ExpoMatch — 20/11/2026

## Decisão de ambiente
Manter o repositório `testandotesteslua-ai/feiras`, GitHub Pages existente e projeto Supabase existente. Não criar cópias da plataforma nem bancos paralelos. Trabalhar com alterações pequenas, reversíveis e verificadas; preservar dados atuais. Para alterações de risco, usar branch temporária no mesmo repositório, sem duplicar ambiente, e publicar após revisão.

## Confirmado no código
- Front-end principal em `index.html`, CSS/JS embutidos.
- Supabase JS 2.117.2 carregado por CDN.
- PWA com `manifest.webmanifest` e `sw.js`.
- Service worker não faz cache offline; possui tratamento de push e clique em notificações, com restrição de navegação à origem/escopo.

## Riscos identificados em auditoria anterior, ainda sem prova de exploração
1. Política de leitura de organizações ativas pode expor colunas além do necessário.
2. Política de atualização por membros pode permitir editar campos reservados à proprietária.
3. Revisar privilégios das funções SECURITY DEFINER e dependências de autorização.
4. Testar inscrições duplicadas e seleção simultânea de vaga.
5. Testar políticas de reembolso e pagamentos.

## Ordem de execução
1. Inspecionar esquema/RLS, funções e permissões efetivas antes de mudar regras.
2. Validar cadastros, login, organização, evento, inscrição e seleção de vaga usando registros de teste identificados no banco atual, sem tocar nos dados reais.
3. Corrigir falhas confirmadas com migrações idempotentes e rollback documentado.
4. Testar pagamentos, cancelamento/reembolso por evento, acessibilidade e experiência mobile.
5. Validar a URL pública após cada publicação, com atenção a erros de JavaScript e autenticação.

## Regras de segurança para alterações
- Nunca publicar chave `service_role` no cliente.
- Não executar comandos destrutivos nem apagar dados existentes sem backup verificado.
- Não afirmar que testes de ponta a ponta foram realizados sem evidência.
- Cada mudança deve registrar arquivo/SQL, motivo, resultado de teste e SHA de commit.
- Políticas de cancelamento/reembolso configuráveis por evento devem ser exibidas e aceitas pelo expositor, observando legislação aplicável.

## Estado atual
Este documento organiza o trabalho no repositório existente. Sua publicação não equivale a correção de código, migração de banco ou validação do aplicativo em navegador.
