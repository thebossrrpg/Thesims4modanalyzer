// src/main.ts

import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import type { Snapshot, NotionCacheSnapshot } from './domain/snapshot.js';
import fs from 'fs';

const inputUrl = process.argv[2];

if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
  console.error('❌ Erro: informe uma URL válida.');
  console.error('Uso: node dist/src/main.js <url>');
  process.exit(1);
}

const startedAt = new Date().toISOString();

try {
  // ═══════════════════════════════════════════════════════
  // PHASE 1: Extração de identidade
  // ═══════════════════════════════════════════════════════
  const identity = await analyzeUrl(inputUrl);

  const displayTitle =
    identity.pageTitle ??
    identity.ogTitle ??
    identity.fallbackLabel ??
    `${identity.domain} · ${identity.urlSlug}`;

  const displaySource =
    identity.pageTitle ? 'pageTitle' :
    identity.ogTitle ? 'ogTitle' :
    identity.fallbackLabel ? 'fallbackLabel' :
    'domainSlug';

  const phase1Output = {
    createdAt: startedAt,
    phase: 'PHASE_1',
    identity,
    displayTitle,
    displaySource
  };

  console.log('✅ Phase 1 — identidade extraída:');
  console.log(JSON.stringify(phase1Output, null, 2));

  // ═══════════════════════════════════════════════════════
  // PHASE 2: Busca no cache Notion
  // ═══════════════════════════════════════════════════════

  // Se já achou na pre-phase (notion_direct), reportar e sair
  if (identity.unfurlVia === 'notion_direct') {
    console.log('\n✅ Match direto encontrado na pre-phase (Notion cache)');
    console.log('ℹ️  Phase 2 fuzzy search não é necessária.\n');

    const snapshot = loadSnapshot('./snapshot.json');

    // Normalizar URL para fazer lookup no snapshot (tratando "#/slug")
    const normalizedIdentityUrl = normalizeUrlForSnapshot(identity.url);

    const notionPage = Object.values(snapshot.phase_2_cache.pages)
      .find(p => normalizeUrlForSnapshot(p.url) === normalizedIdentityUrl);

    if (notionPage) {
      const prePhaseDecision = {
        result: 'FOUND',
        phaseResolved: 'PHASE_2', // ou "PRE_PHASE" se você preferir seguir o tipo Phase
        reason: 'Direct URL match in Notion cache (pre-phase)',
        notionId: notionPage.notionid,
        notionUrl: notionPage.url,
        displayName: notionPage.title ?? notionPage.filename ?? notionPage.url,
        phase2Candidates: 1
      };

      console.log('📄 Decisão:');
      console.log(JSON.stringify(prePhaseDecision, null, 2));
    }

    process.exit(0);
  }

  // Rodar Phase 2 (busca por título/fuzzy)
  console.log('\n🔍 Phase 2 — buscando no cache Notion...\n');
  const snapshot = loadSnapshot('./snapshot.json');
  const phase2Result = await searchNotionCache(identity, snapshot.phase_2_cache.pages);

  console.log('✅ Phase 2 — resultado:');
  console.log(JSON.stringify(phase2Result.decision, null, 2));

  // Mostrar candidatos se houver
  if (phase2Result.candidates && phase2Result.candidates.length > 0) {
    console.log(`\n📋 ${phase2Result.candidates.length} candidatos encontrados:\n`);
    phase2Result.candidates.slice(0, 5).forEach((c, i) => {
      const score = ((c._score || 0) * 100).toFixed(0);
      const reasons = c._reasons?.join(', ') || 'N/A';
      console.log(`  ${i + 1}. "${c.title}"`);
      console.log(`     Score: ${score}% | Razões: ${reasons}`);
      console.log(`     URL: ${c.url}\n`);
    });
  }

  // TODO: Phase 3 (AI fallback)
  if (phase2Result.decision.result === 'NOT_FOUND') {
    console.log('\n⚠️  Não encontrado no cache. Phase 3 (AI fallback) ainda não implementada.');
  }

} catch (err) {
  console.error('\n❌ Erro fatal:');
  console.error(err);
  process.exit(1);
}

/**
 * Carrega snapshot.json do disco
 */
function loadSnapshot(path: string): NotionCacheSnapshot {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Erro ao carregar snapshot de ${path}:`, err);
    throw err;
  }
}

/**
 * Normaliza URL para lookup no snapshot:
 * - Trata hash routing "#/slug" como path "/slug"
 * - Remove fragmento em outros casos
 */
function normalizeUrlForSnapshot(rawUrl: string): string {
  const url = new URL(rawUrl);

  if (url.hash.startsWith('#/')) {
    const hashPath = url.hash.slice(2); // remove "#/"
    url.pathname = '/' + hashPath.replace(/^\/+/, '');
    url.hash = '';
  } else {
    url.hash = '';
  }

  return url.toString();
}
