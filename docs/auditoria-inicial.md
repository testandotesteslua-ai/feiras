# Auditoria inicial — plataforma de feiras (19/11/2026)

> Documento de trabalho na branch `audit/saas-security-review`. Não representa aprovação de segurança nem teste end-to-end. Nenhuma alteração no banco ou na aplicação principal foi aplicada nesta etapa.

## Objetivo do produto
Plataforma comercial para conectar expositores e organizadores de eventos, com suporte futuro a cobrança mensal ou avulsa por evento. A definição comercial e a implementação da cobrança ficam para uma fase posterior. O nome "ExpoMatch" é provisório.

## Observações confirmadas
- Repositório `testandotesteslua-ai/feiras`, branch principal `main`.
- Interface concentrada em `index.html`, com CSS e JavaScript embutidos; PWA com `manifest.webmanifest` e `sw.js`.
- Banco Supabase `plataforma-feiras`; existem tabelas para organizações, membros, edições, inscrições, mapas, vagas e pagamentos/reembolsos.
- As funções `public.adicionar_membro`, `public.excluir_organizacao` e `public.marcar_reembolsado` usam `SECURITY DEFINER` e podem ser invocadas pelo papel `anon` (permissão de execução). **Isso não comprova exploração**: as três têm verificações internas `is_dona` ou `is_membro`. É necessário auditar essas funções auxiliares, seus privilégios e testes com sessão anônima/autenticada.
- O advisor de desempenho do Supabase sinalizou 16 foreign keys sem índice de cobertura. Verificar volume e consultas antes de criar índices.
- `ia_usos` e `push_config` tinham RLS habilitado sem políticas na inspeção inicial; conferir se isso é intencional, pois pode bloquear acesso via cliente.

## Plano de revisão (sem alterar produção)
1. **Autorização e isolamento:** revisar `is_dona`, `is_membro`, `org_da_inscricao`, RLS por organização, privilégios `EXECUTE` e escopo de leitura/escrita. Testar usuário A, usuário B de outra organização e visitante anônimo.
2. **Fluxos críticos:** cadastro, login, criação de organização, convite de membro, publicação de edição, inscrição, aprovação, seleção de vaga, reembolso, exclusão.
3. **Integridade:** evitar inscrições duplicadas, alocação concorrente da mesma vaga e alterações de pagamento por usuários sem permissão.
4. **Front-end:** mapear responsabilidades do `index.html` e extrair módulos gradualmente, com testes de regressão.
5. **Produto comercial:** manter fronteiras por organização e preparar arquitetura de planos sem implementar faturamento agora.
6. **Entrega:** validar em ambiente separado antes de mesclar em `main`; não compartilhar dados reais de produção no ambiente de testes.

## Critérios mínimos antes de comercializar
- Usuários não conseguem acessar ou modificar dados privados de outra organização.
- Todas as ações sensíveis validam autorização no servidor/banco, não apenas na interface.
- Inscrição e alocação de vagas resistem a duplicidade/concorrência.
- Existe procedimento de backup, restauração e migração testado.
- Jornada mobile e desktop validada com contas de teste.

## Decisões pendentes
- Nome comercial definitivo (não renomear arquivos, domínios ou identidade visual até escolha).
- Hospedagem de homologação e estratégia de dados de teste.
- Modelo mensal ou avulso por evento: aprovado como direção futura, sem implementação nesta fase.

## Verificação complementar — autorização e políticas RLS
- `is_dona(p_org)` e `is_membro(p_org)` exigem `auth.uid() is not null` e verificam a associação do usuário à organização, ou `is_admin()`. Isso reduz o risco de execução anônima das funções que dependem delas, mas **não substitui testes com usuários reais de homologação**.
- `org_da_inscricao(p_inscricao)` obtém a organização pela edição da inscrição; é usada como parte da verificação de autorização de `marcar_reembolsado`.
- As políticas de `inscricoes` restringem leitura ao dono da inscrição ou membro da organização e gerenciamento aos membros da organização.
- As políticas de `edicoes`, `mapas` e `mapa_vagas` permitem leitura de organizações ativas por usuários anônimos e autenticados, além da equipe; conferir se todas as colunas são destinadas a acesso público.
- A política `orgs: ver` permite `SELECT` de toda a linha de organizações ativas, inclusive campos como `whatsapp`, `vaga_menor`, `vaga_maior` e `vaga_fundo`. Decidir quais campos devem ser públicos; RLS filtra linhas, **não colunas**.
- A política `orgs: equipe edita` permite que qualquer membro da organização atualize sua linha, desde que continue membro. Verificar se campos como `status`, `criado_por` e preços devem exigir papel de dona/administradora.
- A política `edicoes: equipe gerencia` e políticas similares usam `ALL` com verificação de associação à organização. Avaliar autorização granular para ações financeiras e irreversíveis.

**Status:** revisão estática, sem alterações em produção; nenhuma vulnerabilidade foi demonstrada por teste de exploração. Próximo passo: matriz de permissões e testes em homologação, antes de aplicar restrições que possam interromper funcionalidades.
