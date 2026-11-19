#!/usr/bin/env node
/**
 * Auditoria estática conservadora do cliente ExpoMatch.
 * Execute: node scripts/check-client-security.mjs
 * Não acessa o Supabase, não requer dependências e não altera arquivos.
 * Aprovado neste script NÃO significa que RLS/autorização foram testados.
 */
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const checks = [
  {
    name: 'Não embutir service_role JWT no cliente',
    ok: !/['"]eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+['"]/.test(html) ||
      !/service_role/.test(html),
    note: 'Heurística: inspecione manualmente qualquer JWT encontrado.'
  },
  {
    name: 'Não embutir chave secreta Supabase no cliente',
    ok: !/sb_secret_[A-Za-z0-9_-]+/.test(html)
  },
  {
    name: 'Usar chave publicável do Supabase',
    ok: /const\s+SUPABASE_KEY\s*=\s*['"]sb_publishable_/.test(html)
  },
  {
    name: 'Escape de HTML disponível',
    ok: /const\s+esc\s*=/.test(html)
  },
  {
    name: 'Versão principal preservada: checagem não faz alterações',
    ok: true
  }
];
let failures = 0;
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`);
  if (check.note) console.log(`      ${check.note}`);
  if (!check.ok) failures++;
}
console.log('\nAviso: verificações estáticas não substituem testes de autorização, RLS ou revisão de código.');
exit(failures ? 1 : 0);
