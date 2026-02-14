// src/main.ts (v1.0.5 - COM PHASE 3 + GATES RIGOROSOS)

import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import { aiDisambiguate, isIdentityValidForAI } from './phase3/aiDisambiguate.js';
import { getNotionPageUrl } from './utils/notion.js';
import type { NotionCacheSnapshot } from './domain/snapshot.js';
import type { Identity } from './domain/identity.js';
import type { Decision } from './domain/decision.js';
import fs from 'fs';

const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find(a => !a.startsWith('--'));
const flagJson = rawArgs.includes('--json');

if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
  console.error('❌ Erro: informe uma URL válida.');
  console.error('Uso: node dist/src/main.js <url> [--json]');
  process.exit(1);
}

const startedAt = new Date().toISOString();

interface FinalResult {
  createdAt: string;
  inputUrl: string;
  identity: Identity;
  decision: Decision;
  phase: {
    phase1: { ok: boolean };
    phase2: { ran: boolean; candidates: number };
    phase25: { ran: boolean; urlDiverge: boolean };
    phase3: { ran: boolean; aiConfidence?: number; aiReason?: string };
  };
  candidates: NotionPageWithScore[];
}

interface NotionPageWithScore {
  notionid: string;
  url: string;
  title: string | null;
  filename: string | null;
  creator: string | null;
  createdtime: string;
  lasteditedtime: string;
  _score?: number;
  _reasons?: string[];
}

try {
  // ═══════════════════════════════════════════════════════
  // PHASE 0: URL lookup no snapshot (SEMPRE PRIMEIRO!)
  // ═══════════════════════════════════════════════════════
  const snapshot = loadSnapshot('./snapshot.json');

  const inputKeys = urlLookupKeys(inputUrl);

  console.log('🔍 DEBUG Phase 0:');
  console.log('  Input keys:', inputKeys.slice(0, 8));
  console.log('  Looking for URL match in snapshot...');

  const notionPage = Object.values(snapshot.notion_pages ?? {}).find((p: any) => {
    const pUrl = String((p as any).url ?? '');
    const pKeys = urlLookupKeys(pUrl);
    return pKeys.some(k => inputKeys.includes(k));
  }) as any;

  let final: FinalResult;

  if (notionPage) {
    const notionPageUrlFormatted = getNotionPageUrl(
      notionPage.notion_id,
      notionPage.title ?? notionPage.filename
    );

    final = {
      createdAt: startedAt,
      inputUrl,
      identity: {
        url: inputUrl,
        domain: 'unknown',
        urlSlug: '',
        pageTitle: notionPage.title ?? null,
        ogTitle: null,
        ogSite: null,
        isBlocked: false,
        unfurlVia: 'phase0_direct' as any,
        fallbackLabel: notionPage.title ?? notionPage.filename ?? inputUrl,
      },
      decision: {
        result: 'FOUND',
        phaseResolved: 'PHASE_2',
        reason: 'Direct URL match in Notion snapshot (Phase 0 pre-check)',
        notionId: notionPage.notion_id,
        notionUrl: notionPageUrlFormatted,
        displayName: notionPage.title ?? notionPage.filename ?? notionPage.url,
        phase2Candidates: 1,
        urlDiverge: false,
      },
      phase: {
        phase1: { ok: false },
        phase2: { ran: false, candidates: 1 },
        phase25: { ran: false, urlDiverge: false },
        phase3: { ran: false },
      },
      candidates: [],
    };

    if (flagJson) {
      console.log(JSON.stringify(final, null, 2));
    } else {
      printHumanSummary(final);
    }
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 1: Extração de identidade (só se Phase 0 falhar)
  // ═══════════════════════════════════════════════════════
  const identity = await analyzeUrl(inputUrl);

  final = {
    createdAt: startedAt,
    inputUrl,
    identity,
    decision: {
      result: 'NOT_FOUND',
      phaseResolved: 'PHASE_2',
      reason: 'Pipeline incompleto',
    },
    phase: {
      phase1: { ok: true },
      phase2: { ran: false, candidates: 0 },
      phase25: { ran: false, urlDiverge: false },
      phase3: { ran: false },
    },
    candidates: [],
  };

  // ═══════════════════════════════════════════════════════
  // PHASE 2: Busca fuzzy no cache Notion
  // ═══════════════════════════════════════════════════════
  const phase2Result = await searchNotionCache(identity, snapshot.phase_2_cache.pages);

  final.decision = phase2Result.decision;
  final.phase.phase2 = {
    ran: true,
    candidates: phase2Result.candidates?.length ?? 0,
  };
  final.candidates = (phase2Result.candidates ?? []) as NotionPageWithScore[];

  // ═══════════════════════════════════════════════════════
  // PHASE 2.5: Check URL diverge (só se FOUND)
  // ═══════════════════════════════════════════════════════
  if (final.decision.result === 'FOUND' && final.decision.notionId) {
    final.phase.phase25.ran = true;

    const notionPage2 = Object.values(snapshot.notion_pages ?? {}).find(
      (p: any) => p.notion_id === final.decision.notionId
    ) as any;

    if (notionPage2?.url) {
      const urlDiverge =
        normalizeUrlForSnapshot(identity.url) !== normalizeUrlForSnapshot(String(notionPage2.url));

      final.phase.phase25.urlDiverge = Boolean(urlDiverge);

      if (urlDiverge) {
        final.decision.reason += ` | ⚠️ URL diverge: input=${identity.url} → real=${notionPage2.url}`;
        final.decision.urlDiverge = true;
        final.decision.notionUrl = getNotionPageUrl(
          notionPage2.notion_id,
          notionPage2.title ?? notionPage2.filename
        );
      } else {
        final.decision.notionUrl = getNotionPageUrl(
          notionPage2.notion_id,
          notionPage2.title ?? notionPage2.filename
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 3: IA pra desambiguação (COM GATES RIGOROSOS)
  // ═══════════════════════════════════════════════════════
  
  // GATE 1: Só roda se Phase 2 retornou NOT_FOUND ou AMBIGUOUS
  const phase2Failed = 
    final.decision.result === 'NOT_FOUND' || 
    final.decision.result === 'AMBIGUOUS';

  // GATE 2: Precisa ter entre 2-5 candidatos
  const hasCandidates = 
    final.candidates.length >= 2 && 
    final.candidates.length <= 5;

  // GATE 3: Identidade precisa ser válida
  const hasValidIdentity = isIdentityValidForAI(identity);

  if (phase2Failed && hasCandidates && hasValidIdentity) {
    console.log('\n🤖 [Phase 3] All gates passed, attempting AI disambiguation...');
    
    const aiResult = await aiDisambiguate(identity, final.candidates);
    
    final.phase.phase3 = {
      ran: true,
      aiConfidence: aiResult.confidence,
      aiReason: aiResult.reason
    };
    
    if (aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65) {
      const matched = final.candidates[aiResult.matchedIndex];
      
      // Busca a página no snapshot pra pegar URL formatada
      const matchedInSnapshot = Object.values(snapshot.notion_pages ?? {}).find(
        (p: any) => p.notion_id === matched.notionid
      ) as any;
      
      final.decision = {
        result: 'FOUND',
        phaseResolved: 'PHASE_3',
        reason: `🤖 AI match: ${aiResult.reason} (confidence: ${(aiResult.confidence * 100).toFixed(0)}%)`,
        notionId: matched.notionid,
        notionUrl: matchedInSnapshot 
          ? getNotionPageUrl(matchedInSnapshot.notion_id, matchedInSnapshot.title ?? matchedInSnapshot.filename)
          : matched.url,
        displayName: matched.title || matched.filename || 'Unknown'
      };
      
      console.log('✅ [Phase 3] AI resolved ambiguity!');
    } else {
      console.log('⚠️ [Phase 3] AI could not confidently disambiguate');
    }
  } else {
    // Log detalhado dos gates que falharam
    if (!phase2Failed) {
      console.log('⚠️ [Phase 3] Skipped: Phase 2 already found a match');
    } else if (!hasCandidates) {
      console.log(`⚠️ [Phase 3] Skipped: ${final.candidates.length} candidates (need 2-5)`);
    } else if (!hasValidIdentity) {
      console.log('⚠️ [Phase 3] Skipped: Identity quality too low for AI');
    }
  }

  // ═══════════════════════════════════════════════════════
  // Saída
  // ═══════════════════════════════════════════════════════
  if (flagJson) {
    console.log(JSON.stringify(final, null, 2));
  } else {
    printHumanSummary(final);
  }

} catch (err) {
  console.error('\n❌ Erro fatal:');
  console.error(err);
  process.exit(1);
}

function loadSnapshot(path: string): NotionCacheSnapshot {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Erro ao carregar snapshot de ${path}:`, err);
    throw err;
  }
}

function normalizeUrlForSnapshot(rawUrl: string): string {
  const url = new URL(rawUrl);

  if (url.hash.startsWith('#/')) {
    const hashPath = url.hash.slice(2);
    url.pathname = '/' + hashPath.replace(/^\/+/, '');
  }
  url.hash = '';
  return url.toString();
}

function urlLookupKeys(rawUrl: string): string[] {
  if (!rawUrl) return [];

  let canonical = rawUrl.trim();
  try {
    canonical = normalizeUrlForSnapshot(canonical);
  } catch {
    // snapshot pode ter lixo
  }

  const noScheme = canonical.replace(/^https?:\/\//i, '');
  const compact = noScheme.replace(/[./]/g, '');
  const compactNoWww = noScheme.replace(/^www\./i, '').replace(/[./]/g, '');

  const canonicalNoSlash = canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
  const noSchemeNoSlash = canonicalNoSlash.replace(/^https?:\/\//i, '');
  const compactNoSlash = noSchemeNoSlash.replace(/[./]/g, '');
  const compactNoWwwNoSlash = noSchemeNoSlash.replace(/^www\./i, '').replace(/[./]/g, '');

  return Array.from(new Set([
    canonical,
    canonicalNoSlash,
    noScheme,
    noSchemeNoSlash,
    compact,
    compactNoWww,
    compactNoSlash,
    compactNoWwwNoSlash,
  ]));
}

function printHumanSummary(final: FinalResult): void {
  const { identity, decision, candidates, phase } = final;

  const title =
    identity.pageTitle ??
    identity.ogTitle ??
    identity.fallbackLabel ??
    `${identity.domain} · ${identity.urlSlug}`;

  console.log(`\n📦 ${title}`);
  console.log(`🔗 ${identity.url}`);

  if (decision.result === 'FOUND') {
    console.log('\n✅ Match encontrado no Notion.');
    if (decision.displayName) console.log(`   Nome: ${decision.displayName}`);
    if (decision.notionUrl) console.log(`   🔗 Notion: ${decision.notionUrl}`);
    if (decision.urlDiverge) console.log('   ⚠️  URL diverge detectada!');
    if (decision.reason) console.log(`   Motivo: ${decision.reason}`);
    
    if (decision.phaseResolved === 'PHASE_3' && phase.phase3.aiConfidence) {
      console.log(`   🤖 AI confidence: ${(phase.phase3.aiConfidence * 100).toFixed(0)}%`);
    }
  } else {
    console.log('\nℹ️ Não foi possível encontrar um match no Notion.');
    
    if (phase.phase3.ran) {
      console.log(`⚠️ Phase 3 (IA) executou mas não conseguiu resolver (confidence: ${(phase.phase3.aiConfidence || 0) * 100}%).`);
    }
  }

  if (candidates.length > 0) {
    console.log(`\n📋 Candidatos (até 5):`);
    candidates.slice(0, 5).forEach((c, i) => {
      const score = ((c._score || 0) * 100).toFixed(0);
      const reasons = c._reasons?.join(', ') || 'N/A';
      console.log(`  ${i + 1}. "${c.title}"`);
      console.log(`     Score: ${score}% | Razões: ${reasons}`);
      console.log(`     URL: ${c.url}\n`);
    });
  }

  console.log('');
}
