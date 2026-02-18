// src/main.ts (v1.0.5 - COM PHASE 3 + GATES RIGOROSOS + PHASE 0.5 ESTÁVEL)

import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import { aiDisambiguate, isIdentityValidForAI } from './phase3/aiDisambiguate.js';
import { getNotionPageUrl } from './utils/notion.js';
import fs from 'fs';

import type { NotionCacheSnapshot, NotionPage } from './domain/snapshot.js';
import type { Identity } from './domain/identity.js';


const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find(a => !a.startsWith('--'));
const flagJson = rawArgs.includes('--json');

if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
  console.error('❌ Erro: informe uma URL válida.');
  console.error('Uso: node dist/src/main.js <url> [--json]');
  process.exit(1);
}

const startedAt = new Date().toISOString();

try {

  // ═══════════════════════════════════════════════════════
  // PHASE 0: URL lookup exato
  // ═══════════════════════════════════════════════════════

  const snapshot: NotionCacheSnapshot = loadSnapshot('./snapshot.json');
  const notionPages: NotionPage[] = Object.values(
  snapshot.notion_pages ?? {}
);

  const inputKeys = urlLookupKeys(inputUrl);

  console.log('🔍 DEBUG Phase 0:');
  console.log('  Input keys:', inputKeys.slice(0, 8));
  console.log('  Looking for URL match in snapshot...');

  const notionPage = notionPages.find((p) => {
    if (!p.url) return false;
    const pKeys = urlLookupKeys(p.url);
    return pKeys.some(k => inputKeys.includes(k));
  });

  let final: any;

  if (notionPage) {
    final = buildFoundResult({
      startedAt,
      inputUrl,
      notionPage,
      reason: 'Direct URL match in Notion snapshot (Phase 0 pre-check)',
      phaseResolved: 'PHASE_0'
    });

    outputAndExit(final, flagJson);
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 0.5: Canonical Slug Match
  // ═══════════════════════════════════════════════════════

  const inputSlugData = extractFinalSlug(inputUrl);

  if (inputSlugData) {

    const slugMatches = notionPages.filter((p) => {
      if (!p.url) return false;

      const snapSlug = extractFinalSlug(p.url);
      if (!snapSlug) return false;

      return snapSlug.slug === inputSlugData.slug;
    });

    if (slugMatches.length === 1) {

      const match = slugMatches[0];
      const snapSlugData = extractFinalSlug(match.url!);

      final = buildFoundResult({
        startedAt,
        inputUrl,
        notionPage: match,
        reason:
          snapSlugData?.domain === inputSlugData.domain
            ? 'Slug match (same domain)'
            : 'Slug match (cross-domain)',
        phaseResolved: 'PHASE_0.5'
      });

      outputAndExit(final, flagJson);
    }
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 1
  // ═══════════════════════════════════════════════════════

  const identity = await analyzeUrl(inputUrl);

  final = {
    createdAt: startedAt,
    inputUrl,
    identity,
    decision: {
      result: 'NOT_FOUND',
      phaseResolved: 'PHASE_2',
      reason: 'Pipeline incompleto'
    },
    phase: {
      phase1: { ok: true },
      phase2: { ran: false, candidates: 0 },
      phase25: { ran: false, urlDiverge: false },
      phase3: { ran: false }
    },
    candidates: []
  };

  // ═══════════════════════════════════════════════════════
  // PHASE 2
  // ═══════════════════════════════════════════════════════

  const phase2Result = await searchNotionCache(
    identity,
    snapshot.phase_2_cache?.pages ?? {}
  );

  final.decision = phase2Result.decision;
  final.phase.phase2 = {
    ran: true,
    candidates: phase2Result.candidates?.length ?? 0
  };
  final.candidates = phase2Result.candidates ?? [];

  // ═══════════════════════════════════════════════════════
  // PHASE 3
  // ═══════════════════════════════════════════════════════

  const phase2Failed =
    final.decision.result === 'NOT_FOUND' ||
    final.decision.result === 'AMBIGUOUS';

  const hasCandidates =
    final.candidates.length >= 2 &&
    final.candidates.length <= 5;

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

      final.decision = {
        result: 'FOUND',
        phaseResolved: 'PHASE_3',
        reason: `🤖 AI match: ${aiResult.reason} (${(
          aiResult.confidence * 100
        ).toFixed(0)}%)`,
        notionId: matched.notion_id,
        notionUrl: getNotionPageUrl(
          matched.notion_id,
          matched.title ?? matched.filename
        ),
        displayName:
          matched.title ?? matched.filename ?? matched.url
      };

      console.log('✅ [Phase 3] AI resolved ambiguity!');
    }
  }

  output(final, flagJson);

} catch (err) {
  console.error('\n❌ Erro fatal:');
  console.error(err);
  process.exit(1);
}


// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function buildFoundResult({
  startedAt,
  inputUrl,
  notionPage,
  reason,
  phaseResolved
}: {
  startedAt: string;
  inputUrl: string;
  notionPage: NotionPage;
  reason: string;
  phaseResolved: string;
}) {
  return {
    createdAt: startedAt,
    inputUrl,
    identity: {
      url: inputUrl,
      domain: 'snapshot',
      urlSlug: '',
      pageTitle: notionPage.title ?? null,
      ogTitle: null,
      ogSite: null,
      isBlocked: false,
      unfurlVia: phaseResolved,
      fallbackLabel:
        notionPage.title ??
        notionPage.filename ??
        inputUrl
    },
    decision: {
      result: 'FOUND',
      phaseResolved,
      reason,
      notionId: notionPage.notion_id,
      notionUrl: getNotionPageUrl(
        notionPage.notion_id,
        notionPage.title ??
        notionPage.filename ??
        notionPage.url ??
        notionPage.notion_id
    ),

      displayName:
        notionPage.title ??
        notionPage.filename ??
        notionPage.url
    },
    phase: {
      phase1: { ok: false },
      phase2: { ran: false, candidates: 1 },
      phase25: { ran: false, urlDiverge: false },
      phase3: { ran: false }
    },
    candidates: []
  };
}

function outputAndExit(final: any, flagJson: boolean) {
  output(final, flagJson);
  process.exit(0);
}

function output(final: any, flagJson: boolean) {
  if (flagJson) {
    console.log(JSON.stringify(final, null, 2));
  } else {
    printHumanSummary(final);
  }
}

function loadSnapshot(path: string): NotionCacheSnapshot {
  const raw = fs.readFileSync(path, 'utf-8');
  return JSON.parse(raw) as NotionCacheSnapshot;
}

function extractFinalSlug(rawUrl: string): { slug: string; domain: string } | null {
  try {
    const url = new URL(rawUrl);
    const domain = url.hostname.replace(/^www\./i, '').toLowerCase();

    const parts = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);

    if (!parts.length) return null;

    const slug = parts[parts.length - 1]
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '');

    if (!slug) return null;

    return { slug, domain };
  } catch {
    return null;
  }
}

function urlLookupKeys(rawUrl: string) {
  if (!rawUrl) return [];
  const canonical = rawUrl.trim();
  const noScheme = canonical.replace(/^https?:\/\//i, '');
  const compact = noScheme.replace(/[./]/g, '');
  return [canonical, noScheme, compact];
}

function printHumanSummary(final: any) {
  const { identity, decision } = final;

  console.log(`\n📦 ${identity.pageTitle ?? identity.fallbackLabel}`);
  console.log(`🔗 ${identity.url}`);

  if (decision.result === 'FOUND') {
    console.log('\n✅ Match encontrado no Notion.');
    console.log(`   Nome: ${decision.displayName}`);
    console.log(`   🔗 Notion: ${decision.notionUrl}`);
    console.log(`   Motivo: ${decision.reason}`);
  } else {
    console.log('\nℹ️ Não foi possível encontrar um match no Notion.');
  }

  console.log('');
}
