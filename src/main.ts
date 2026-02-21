// src/main.ts — v1.2.0
//
// [FIX-4a] Phase 1 hard 404 → REJECTED_404 estruturado (inner try/catch)
// [FIX-4b] AiDecisionCache integrado; persistDecision respeita regra determinística
// [FIX]    mapUnfurlViaToProvider, candidatesToDebugTop5 → importados de debug.ts
// [FIX]    createBaseDebug / setRejected404 → importados de debug.ts
// [FIX]    snapshotVersion → buildSnapshotVersion(snapshot)
// [FIX]    POLICY_VERSION como constante explícita

import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import { aiDisambiguate, isIdentityValidForAI } from './phase3/aiDisambiguate.js';
import { getNotionPageUrl } from './utils/notion.js';
import { CacheEngine } from './utils/cacheEngine.js';
import { AiDecisionCache } from './cache/aiDecisionCache.js';
import { phase25Rescue } from './phase2/phase25Rescue.js';
import {
  buildPhase25Debug,
  buildPhase3Debug,
  mapUnfurlViaToProvider,
  candidatesToDebugTop5,
  createBaseDebug,
  setRejected404,
} from './utils/debug.js';
import { buildSnapshotVersion } from './utils/snapshotVersion.js';

import fs from 'fs';

import type { NotionCacheSnapshot, NotionPage } from './domain/snapshot.js';
import type { Identity } from './domain/identity.js';
import type {
  AnalyzerJsonOutput,
  DebugExpander,
  AnalyzerResultStatus,
  PhaseResolved,
} from './domain/analyzerJsonOutput.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────

const POLICY_VERSION = 'phase3-ai-v1';

// ─────────────────────────────────────────────────────────────
// ARGS
// ─────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find((a) => !a.startsWith('--'));
const flagJson = rawArgs.includes('--json');
const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────

function emit(out: AnalyzerJsonOutput): void {
  if (flagJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printHumanSummary(out);
  }
}

function printHumanSummary(out: AnalyzerJsonOutput): void {
  console.log(`\n🔗 ${out.inputUrl}`);
  console.log(`📌 Resultado: ${out.status}`);
  if (out.reason) console.log(`🧠 Motivo: ${out.reason}`);

  if (out.status === 'FOUND' && out.found) {
    console.log(`✅ Match: ${out.found.title ?? out.found.pageId}`);
    if (out.found.pageUrl) console.log(`🗂️  Notion: ${out.found.pageUrl}`);
  }

  if (out.status === 'AMBIGUOUS' && out.ambiguous) {
    console.log(`⚠️  Candidatos: ${out.ambiguous.pageIds.join(', ')}`);
  }

  if (out.status === 'REJECTED_404') {
    const r = out.debug.validation.rejected404Reason ?? '(sem motivo)';
    console.log(`⛔ URL rejeitada: ${r}`);
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────
// HELPERS — snapshot / Phase 0 / 0.5
// ─────────────────────────────────────────────────────────────

function loadSnapshot(snapshotPath: string): NotionCacheSnapshot {
  const raw = fs.readFileSync(snapshotPath, 'utf-8');
  return JSON.parse(raw) as NotionCacheSnapshot;
}

function urlLookupKeys(rawUrl: string): string[] {
  if (!rawUrl) return [];
  const canonical = rawUrl.trim();
  const noScheme = canonical.replace(/^https?:\/\//i, '');
  const compact = noScheme.replace(/[./]/g, '');
  return [canonical, noScheme, compact];
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
    const slug = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9\-]/g, '');
    if (!slug) return null;
    return { slug, domain };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS — cache
// ─────────────────────────────────────────────────────────────

/**
 * Persiste decisão nos caches corretos conforme a fase:
 * - URL cache   → apenas fases determinísticas (PHASE_0, PHASE_0_5, REJECTED_404)
 * - Evidence    → quando há evidenceKey (Phase 2/3)
 * - AiCache     → redundância para Phase 3 (por evidenceKey)
 */
function persistDecision(
  cache: CacheEngine,
  aiCache: AiDecisionCache,
  url: string,
  out: AnalyzerJsonOutput,
  evidenceKey?: string,
  candidates?: NotionPage[],
  aiConfidence?: number
): void {
  const isDeterministic =
    out.phaseResolved === 'REJECTED_404' ||
    out.phaseResolved === 'PHASE_0' ||
    out.phaseResolved === 'PHASE_0_5';

  const entry = cache.makeDecisionEntry({
    result: out.status,
    reason: out.reason ?? '',
    phaseResolved: out.phaseResolved,
    url,
    evidenceKey,
    chosenNotionId: out.found?.pageId,
    candidates: candidates ?? [],
  });

  if (isDeterministic) {
    cache.setUrlDecision(url, entry);
  }

  if (evidenceKey) {
    cache.setDecision(evidenceKey, entry);

    aiCache.set(evidenceKey, {
      result: out.status,
      phaseResolved: out.phaseResolved,
      reason: out.reason ?? '',
      chosenNotionId: out.found?.pageId,
      confidence: aiConfidence,
    });
    aiCache.save();
  }

  cache.save();
}

function hydrateFoundFromCandidates(
  notionId: string,
  candidates: NotionPage[]
): { pageId: string; pageUrl?: string; title: string } {
  const match = candidates.find((c: any) => c.notion_id === notionId);
  const title = match
    ? String((match as any).title ?? (match as any).filename ?? (match as any).url ?? notionId)
    : String(notionId);
  return {
    pageId: notionId,
    pageUrl: getNotionPageUrl(notionId, title),
    title,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

(async () => {

  // ── VALIDAÇÃO / REJECTED_404 ─────────────────────────────

  const debug: DebugExpander = createBaseDebug(inputUrl);

  if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
    setRejected404(debug, 'url_not_http');

    const out: AnalyzerJsonOutput = {
      startedAt,
      inputUrl: inputUrl ?? '',
      status: 'REJECTED_404',
      phaseResolved: 'REJECTED_404',
      reason: 'URL não é http(s)',
      debug,
    };

    emit(out);
    process.exit(0);
  }

  try {

    // ── SNAPSHOT + CACHE INIT ────────────────────────────────

    const snapshot: NotionCacheSnapshot = loadSnapshot("./snapshot.json");
    const snapshotVersion = buildSnapshotVersion(snapshot);

    const cache = CacheEngine.load(snapshotVersion);
    const aiCache = AiDecisionCache.load(snapshotVersion, POLICY_VERSION);

    // ⚡ URL CACHE SHORT-CIRCUIT (determinístico)
    const urlCacheHit = cache.getUrlDecision(inputUrl);
    if (urlCacheHit) {
      console.log("⚡ URL cache hit");

    // Hidratação determinística: procura no snapshot "real" (Phase 0/0.5)
    let found:
      | { pageId: string; pageUrl?: string; title: string }
      | undefined = undefined;

    if (urlCacheHit.chosenNotionId) {
    const id = urlCacheHit.chosenNotionId;

    // 1) tenta pelo snapshot (fonte de verdade do Phase 0/0.5)
    const snapPage = snapshot.notion_pages?.[id];

    if (snapPage) {
      const title =
        snapPage.title ?? snapPage.filename ?? snapPage.url ?? snapPage.notion_id;

      found = {
        pageId: id,
        pageUrl: getNotionPageUrl(id, title),
        title,
      };
    } else {
      // 2) fallback: tenta phase_2_cache (caso você tenha gravado chosenNotionId vindo de Phase 2/3 por acidente)
      const p2Page = snapshot.phase_2_cache?.pages?.[id];
      const title =
        p2Page?.title ?? p2Page?.filename ?? p2Page?.url ?? id;

      found = {
        pageId: id,
        pageUrl: getNotionPageUrl(id, title),
        title,
      };
    }
  }

  const cachedOut: AnalyzerJsonOutput = {
    startedAt,
    inputUrl,
    status: urlCacheHit.result as AnalyzerResultStatus,
    phaseResolved: urlCacheHit.phaseResolved as PhaseResolved,
    reason: urlCacheHit.reason,
    debug,
    meta: {
      decisionCache: { hit: true, key: urlCacheHit.urlKey },
    },
    ...(found ? { found } : {}),
  };

  emit(cachedOut);
  process.exit(0);
}

    // ✅ IMPORTANTÍSSIMO: não misturar datasets.
    // - Phase 0/0.5 precisam da URL ORIGINAL (fonte).
    // - Phase 2 precisa do índice/cache pra fuzzy.
      const notionPagesPhase0: Record<string, NotionPage> = snapshot.notion_pages ?? {};
      const notionPagesPhase2: Record<string, NotionPage> = snapshot.phase_2_cache?.pages ?? {};


    // ── PHASE 0 — URL lookup exato ───────────────────────────

    const inputKeys = urlLookupKeys(inputUrl);

    console.log("🧪 [Probe] Phase 0 running. pages0 =", Object.keys(notionPagesPhase0).length);
    const phase0Match = Object.values(notionPagesPhase0).find((p) => {
      if (!p.url) return false;
      const pKeys = urlLookupKeys(p.url);
      return pKeys.some((k) => inputKeys.includes(k));
    });

    debug.phase0 = {
      exactMatch: Boolean(phase0Match),
      matchedPageId: phase0Match?.notion_id,
    };

    if (phase0Match) {
      const title =
        phase0Match.title ?? phase0Match.filename ?? phase0Match.url ?? phase0Match.notion_id;

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: 'FOUND',
        phaseResolved: 'PHASE_0',
        reason: 'Direct URL match in Notion snapshot (Phase 0)',
        debug,
        found: {
          pageId: phase0Match.notion_id,
          pageUrl: getNotionPageUrl(phase0Match.notion_id, title),
          title,
        },
      };

      persistDecision(cache, aiCache, inputUrl, out);
      emit(out);
      process.exit(0);
    }

    // ── PHASE 0.5 — Slug match ───────────────────────────────

    const inputSlugData = extractFinalSlug(inputUrl);
    let phase05Match: NotionPage | null = null;

    if (inputSlugData) {
      const slugMatches = Object.values(notionPagesPhase0).filter((p) => {
        if (!p.url) return false;
        const snapSlug = extractFinalSlug(p.url);
        if (!snapSlug) return false;
        return snapSlug.slug === inputSlugData.slug;
      });

      if (slugMatches.length === 1) {
        phase05Match = slugMatches[0];
      }
    }

    debug.phase05 = {
      slugMatch: Boolean(phase05Match),
      matchedPageId: phase05Match?.notion_id,
    };

    if (phase05Match) {
      const snapSlugData = extractFinalSlug(phase05Match.url!);
      const title =
        phase05Match.title ?? phase05Match.filename ?? phase05Match.url ?? phase05Match.notion_id;

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: 'FOUND',
        phaseResolved: 'PHASE_0_5',
        reason:
          snapSlugData?.domain === inputSlugData?.domain
            ? 'Slug match (same domain)'
            : 'Slug match (cross-domain)',
        debug,
        found: {
          pageId: phase05Match.notion_id,
          pageUrl: getNotionPageUrl(phase05Match.notion_id, title),
          title,
        },
      };

      persistDecision(cache, aiCache, inputUrl, out);
      emit(out);
      process.exit(0);
    }

    // ── PHASE 1 — analyzeUrl → Identity ─────────────────────
    // [FIX-4a] Hard 404 capturado aqui → REJECTED_404 estruturado
    //          Erros reais de rede/parse são re-lançados → catch externo → exit 1

    let identity: Identity;

    try {
      identity = await analyzeUrl(inputUrl);
    } catch (phase1Err: any) {
      const msg = String(phase1Err?.message ?? '');
      const is404 =
        msg.toLowerCase().includes('404') ||
        msg.toLowerCase().includes('não retornou') ||
        msg.toLowerCase().includes('page not found') ||
        msg.toLowerCase().includes('not found');

      if (!is404) {
        // Erro inesperado → propaga para o catch externo (exit 1)
        throw phase1Err;
      }

      setRejected404(debug, msg);

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: 'REJECTED_404',
        phaseResolved: 'REJECTED_404',
        reason: 'Página inválida ou URL não retornou conteúdo válido (hard 404).',
        debug,
      };

      // REJECTED_404 é determinístico → grava no URL cache
      persistDecision(cache, aiCache, inputUrl, out);
      emit(out);
      process.exit(0);
    }

    debug.phase1 = {
      blocked: Boolean(identity.isBlocked),
      providersUsed: [mapUnfurlViaToProvider(identity.unfurlVia)],
      identity,
    };

    // ── PHASE 2 — fuzzy no snapshot ──────────────────────────

    const phase2Result = await searchNotionCache(identity, notionPagesPhase2);
    const phase2Candidates: NotionPage[] = phase2Result.candidates ?? [];

    debug.phase2 = {
      candidatesCount: phase2Candidates.length,
      candidatesTop5: candidatesToDebugTop5(phase2Candidates),
    };

    // Short-circuit: Phase 2 resolveu com confiança
    if (phase2Result.decision.result === 'FOUND') {
      const pageId = phase2Result.decision.notionId ?? '';
      const title = phase2Result.decision.displayName ?? '';

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: 'FOUND',
        phaseResolved: 'PHASE_2',
        reason: phase2Result.decision.reason ?? '',
        debug,
        found: {
          pageId,
          pageUrl: getNotionPageUrl(pageId, title || pageId),
          title,
        },
      };

      // TODO: construir evidenceKey aqui também para cachear por evidência
      persistDecision(cache, aiCache, inputUrl, out, undefined, phase2Candidates);
      emit(out);
      process.exit(0);
    }

    // ── PHASE 2.5 — rescue (fonte única de verdade) ──────────

    const rescue = phase25Rescue(phase2Candidates);
    const phase3Candidates = rescue.plan.phase3Candidates;

    debug.phase25 = buildPhase25Debug(phase3Candidates, rescue.selectionRule);

    // Short-circuit: Phase 2.5 decidiu não chamar Phase 3
    if (!rescue.plan.shouldCallPhase3) {
      const d = phase2Result.decision;

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: d.result as AnalyzerResultStatus,
        phaseResolved: d.phaseResolved as PhaseResolved,
        reason: d.reason ?? '',
        debug,
        ...(d.notionId
          ? { found: hydrateFoundFromCandidates(d.notionId, phase3Candidates) }
          : {}),
      };

      persistDecision(cache, aiCache, inputUrl, out, undefined, phase3Candidates);
      emit(out);
      process.exit(0);
    }

    // ── EVIDENCE CACHE SHORT-CIRCUIT ─────────────────────────

    const evidenceKey = cache.buildEvidenceKey({
      identity,
      candidates: phase3Candidates,
      policyVersion: POLICY_VERSION,
    });

    // 1) AiDecisionCache (mais específico para Phase 3)
    const aiCacheHit = aiCache.get(evidenceKey);
    if (aiCacheHit) {
      console.log('⚡ AI evidence cache hit');

      const cachedOut: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: aiCacheHit.result,
        phaseResolved: aiCacheHit.phaseResolved,
        reason: aiCacheHit.reason,
        debug,
        meta: {
          aiDecisionCache: { hit: true, key: evidenceKey },
        },
        ...(aiCacheHit.chosenNotionId
          ? { found: hydrateFoundFromCandidates(aiCacheHit.chosenNotionId, phase3Candidates) }
          : {}),
      };

      emit(cachedOut);
      process.exit(0);
    }

    // 2) CacheEngine decision cache (fallback)
    const decisionCacheHit = cache.getDecision(evidenceKey);
    if (decisionCacheHit) {
      console.log('⚡ Evidence cache hit');

      const cachedOut: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: decisionCacheHit.result as AnalyzerResultStatus,
        phaseResolved: decisionCacheHit.phaseResolved as PhaseResolved,
        reason: decisionCacheHit.reason,
        debug,
        meta: {
          decisionCache: { hit: true, key: evidenceKey },
        },
        ...(decisionCacheHit.chosenNotionId
          ? { found: hydrateFoundFromCandidates(decisionCacheHit.chosenNotionId, phase3Candidates) }
          : {}),
      };

      emit(cachedOut);
      process.exit(0);
    }

    // ── PHASE 3 — AI Disambiguation ──────────────────────────

    const phase2Failed =
      phase2Result.decision.result === 'NOTFOUND' ||
      phase2Result.decision.result === 'AMBIGUOUS';

    const hasValidIdentity = isIdentityValidForAI(identity);

    if (phase2Failed && rescue.plan.shouldCallPhase3 && hasValidIdentity) {
      console.log('\n🤖 [Phase 3] All gates passed, attempting AI disambiguation...');

      const aiResult = await aiDisambiguate(identity, phase3Candidates);
      const aiMatched = aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65;

      debug.phase3 = buildPhase3Debug({
        mode: 'offline',
        finalCandidates: aiMatched ? 1 : phase3Candidates.length,
        finalCandidatePageIds: aiMatched
          ? [String((phase3Candidates[aiResult.matchedIndex] as any).notion_id)]
          : undefined,
      });

      if (aiMatched) {
        const matched: any = phase3Candidates[aiResult.matchedIndex];
        const title = matched.title ?? matched.filename ?? matched.url ?? matched.notion_id;
        const reason = `AI match: ${aiResult.reason} (${(aiResult.confidence * 100).toFixed(0)}%)`;

        const out: AnalyzerJsonOutput = {
          startedAt,
          inputUrl,
          status: 'FOUND',
          phaseResolved: 'PHASE_3',
          reason,
          debug,
          found: {
            pageId: matched.notion_id,
            pageUrl: getNotionPageUrl(matched.notion_id, title),
            title,
          },
        };

        persistDecision(cache, aiCache, inputUrl, out, evidenceKey, phase3Candidates, aiResult.confidence);
        emit(out);
        process.exit(0);
      }
    }

    // ── SAÍDA FINAL — não resolveu ────────────────────────────

    if (phase2Result.decision.result === 'AMBIGUOUS') {
      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: 'AMBIGUOUS',
        phaseResolved: 'PHASE_2',
        reason: phase2Result.decision.reason ?? '',
        debug,
        ambiguous: {
          pageIds: phase2Candidates.map((c: any) => String(c.notion_id)),
        },
      };

      persistDecision(cache, aiCache, inputUrl, out, evidenceKey, phase3Candidates);
      emit(out);
      process.exit(0);
    }

    // NOTFOUND
    const out: AnalyzerJsonOutput = {
      startedAt,
      inputUrl,
      status: 'NOTFOUND',
      phaseResolved: 'PHASE_2',
      reason: phase2Result.decision.reason ?? '',
      debug,
    };

    persistDecision(cache, aiCache, inputUrl, out, evidenceKey, phase3Candidates);
    emit(out);
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Erro fatal:');
    console.error(err);
    process.exit(1);
  }

})();
