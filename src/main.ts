// src/main.ts — v1.1.0-merged
//
// ┌─ Do v1 → CacheEngine (URL cache + evidence-based cache), persistDecision
// └─ Do v2 → AnalyzerJsonOutput tipado, DebugExpander por fase, emit(),
//            contrato de saídas estruturado (FOUND / AMBIGUOUS / NOTFOUND / REJECTED_404)
//
// [BUG-FIX] Gate Phase 3: "NOT_FOUND" → "NOTFOUND"
// [STUB]    Phase 2.5 — roteamento correto, implementação pendente
// [STUB]    Phase 3   — Notion live por pageId pendente (AI stub mantido)

import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import { aiDisambiguate, isIdentityValidForAI } from './phase3/aiDisambiguate.js';
import { getNotionPageUrl } from './utils/notion.js';
import { CacheEngine } from './utils/cacheEngine.js';
import fs from 'fs';

import type { NotionCacheSnapshot, NotionPage } from './domain/snapshot.js';
import type { Identity, UnfurlVia } from './domain/identity.js';
import type {
  AnalyzerJsonOutput,
  DebugExpander,
  ProviderUsed,
  CandidateDebug,
  AnalyzerResultStatus,
  PhaseResolved
} from './domain/analyzerJsonOutput.js';

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

function loadSnapshot(path: string): NotionCacheSnapshot {
  const raw = fs.readFileSync(path, 'utf-8');
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
// HELPERS — debug
// ─────────────────────────────────────────────────────────────

function mapUnfurlViaToProvider(via: UnfurlVia): ProviderUsed {
  switch (via) {
    case 'og_web_scraper': return 'html';
    case 'local_ogs':      return 'localOgs';
    case 'iframely':       return 'iframely';
    default:               return 'html';
  }
}

function candidatesToDebugTop5(candidates: NotionPage[]): CandidateDebug[] {
  return candidates.slice(0, 5).map((c: any) => ({
    title: (c.title ?? c.filename ?? c.url ?? 'Unknown') as string,
    pageId: (c.notion_id ?? '') as string,
    score: typeof c._score === 'number' ? c._score : 0
  }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS — cache (v1)
// ─────────────────────────────────────────────────────────────

function persistDecision(
  cache: CacheEngine,
  url: string,
  out: AnalyzerJsonOutput,
  evidenceKey?: string,
  candidates?: NotionPage[]
): void {
  const entry = cache.makeDecisionEntry({
    result: out.status,
    reason: out.reason ?? '',
    phaseResolved: out.phaseResolved,
    url,
    evidenceKey,
    chosenNotionId: out.found?.pageId,
    candidates: candidates ?? []
  });
  cache.setUrlDecision(url, entry);
  if (evidenceKey) cache.setDecision(evidenceKey, entry);
  cache.save();
}

function hydrateFoundFromCandidates(
  notionId: string,
  candidates: NotionPage[]
): { pageId: string; pageUrl?: string; title: string } {
  const match = candidates.find((c: any) => c.notion_id === notionId);
  const title = match
    ? ((match as any).title ?? (match as any).filename ?? (match as any).url ?? notionId)
    : notionId;
  return {
    pageId: notionId,
    pageUrl: getNotionPageUrl(notionId, title),
    title
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

(async () => {

  // ── VALIDAÇÃO / REJECTED_404 ─────────────────────────────

  const debug: DebugExpander = {
    validation: {
      isValidHttpUrl: Boolean(inputUrl && /^https?:\/\//i.test(inputUrl))
    }
  };

  if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
    debug.validation.isValidHttpUrl = false;
    debug.validation.rejected404Reason = 'url_not_http';

    const out: AnalyzerJsonOutput = {
      startedAt,
      inputUrl: inputUrl ?? '',
      status: 'REJECTED_404',
      phaseResolved: 'REJECTED_404',
      reason: 'URL não é http(s)',
      debug
    };

    emit(out);
    process.exit(0);
  }

  try {

    // ── SNAPSHOT + CACHE INIT (v1) ───────────────────────────

    const snapshot: NotionCacheSnapshot = loadSnapshot('./snapshot.json');
    const snapshotVersion =
      snapshot.meta?.version ??
      String(Object.keys(snapshot.notion_pages ?? {}).length);

    const cache = CacheEngine.load(snapshotVersion);

    // ⚡ URL CACHE SHORT-CIRCUIT (v1)
    const urlCacheHit = cache.getUrlDecision(inputUrl);
    if (urlCacheHit) {
      console.log('⚡ URL cache hit');
      // Hidrata saída tipada a partir da entrada de cache
      const cachedOut: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: urlCacheHit.result as AnalyzerResultStatus,
        phaseResolved: urlCacheHit.phaseResolved as PhaseResolved,
        reason: urlCacheHit.reason,
        debug,
        ...(urlCacheHit.chosenNotionId
          ? { found: hydrateFoundFromCandidates(urlCacheHit.chosenNotionId, []) }
          : {})
      };
      emit(cachedOut);
      process.exit(0);
    }

    const notionPages: NotionPage[] = Object.values(snapshot.notion_pages ?? {});

    // ── PHASE 0 — URL lookup exato ───────────────────────────

    const inputKeys = urlLookupKeys(inputUrl);

    const phase0Match = notionPages.find((p) => {
      if (!p.url) return false;
      const pKeys = urlLookupKeys(p.url);
      return pKeys.some((k) => inputKeys.includes(k));
    });

    debug.phase0 = {
      exactMatch: Boolean(phase0Match),
      matchedPageId: phase0Match?.notion_id
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
          title
        }
      };

      persistDecision(cache, inputUrl, out);
      emit(out);
      process.exit(0);
    }

    // ── PHASE 0.5 — Slug match ───────────────────────────────

    const inputSlugData = extractFinalSlug(inputUrl);
    let phase05Match: NotionPage | null = null;

    if (inputSlugData) {
      const slugMatches = notionPages.filter((p) => {
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
      matchedPageId: phase05Match?.notion_id
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
          title
        }
      };

      persistDecision(cache, inputUrl, out);
      emit(out);
      process.exit(0);
    }

    // ── PHASE 1 — analyzeUrl → Identity ─────────────────────

    const identity: Identity = await analyzeUrl(inputUrl);

    debug.phase1 = {
      blocked: Boolean(identity.isBlocked),
      providersUsed: [mapUnfurlViaToProvider(identity.unfurlVia)],
      identity
    };

        // ── PHASE 2 — fuzzy no snapshot ──────────────────────────

    const phase2Result = await searchNotionCache(
      identity,
      snapshot.phase_2_cache?.pages ?? {}
    );

    const phase2Candidates: NotionPage[] = phase2Result.candidates ?? [];

    debug.phase2 = {
      candidatesCount: phase2Candidates.length,
      candidatesTop5: candidatesToDebugTop5(phase2Candidates)
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
          title
        }
      };

      // URL cache ok aqui (decisão determinística o suficiente)
      persistDecision(cache, inputUrl, out, undefined, phase2Candidates);
      emit(out);
      process.exit(0);
    }

        // ── PHASE 2.5 — roteamento (agora REAL) ───────────────────
    // Usa o plano da Phase 2.5 (quando existir) como autoridade:
    // - DISAMBIGUATE: 2..5 candidatos
    // - CONFIRM_SINGLE_WEAK: 1 candidato
    // - SKIP: não chama Phase 3
    const plan = phase2Result.phase25;

    // Notinha #1: o conjunto REAL que vai pra Phase 3 também é o que entra no evidenceKey/caches
    const phase3Candidates: NotionPage[] =
      plan?.phase3Candidates && plan.phase3Candidates.length > 0
        ? plan.phase3Candidates
        : phase2Candidates;

    // Corrige erros de tipagem: DebugPhase25 tem shape fixo
    // Como ainda não implementamos "rescue" de verdade, a regra é sempre SANITY_TOPK aqui.
    // (Se um dia você fizer fallback top2, aí sim vira FALLBACK_TOP2)
    debug.phase25 = {
      candidatesCount: phase3Candidates.length,
      candidates: candidatesToDebugTop5(phase3Candidates),
      selectionRule: 'SANITY_TOPK'
    };

    // ── EVIDENCE CACHE SHORT-CIRCUIT (v1) ────────────────────
    // Notinha #1 (continuação): evidenceKey deve refletir o input REAL da Phase 3 (phase3Candidates)
    const evidenceKey = cache.buildEvidenceKey({
      identity,
      candidates: phase3Candidates,
      policyVersion: 'phase3-ai-v1'
    });

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
        ...(decisionCacheHit.chosenNotionId
          ? { found: hydrateFoundFromCandidates(decisionCacheHit.chosenNotionId, phase3Candidates) }
          : {})
      };

      emit(cachedOut);
      process.exit(0);
    }

    // ── PHASE 3 — AI Disambiguation (STUB → Notion live TODO) ─
    // [BUG-FIX] gate "NOT_FOUND" → "NOTFOUND"
    const phase2Failed =
      phase2Result.decision.result === 'NOTFOUND' ||
      phase2Result.decision.result === 'AMBIGUOUS';

    const hasValidIdentity = isIdentityValidForAI(identity);

    // Notinha #3: Gate é o Phase 2.5.
    // Se plan não existir (por segurança), cai no comportamento antigo.
    const shouldCallPhase3 =
      plan?.shouldCallPhase3 ??
      (phase3Candidates.length >= 2 && phase3Candidates.length <= 5);

    if (phase2Failed && shouldCallPhase3 && hasValidIdentity) {
      console.log('\n🤖 [Phase 3] All gates passed (via Phase 2.5), attempting AI disambiguation...');

      // Notinha #2: aiDisambiguate precisa aceitar 1 candidato — o seu já aceita ✅
      const aiResult = await aiDisambiguate(identity, phase3Candidates);

      debug.phase3 = {
        mode: 'offline', // TODO: trocar para 'online' quando implementar Notion live
        finalCandidates:
          aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65
            ? 1
            : phase3Candidates.length,
        finalCandidatePageIds:
          aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65
            ? [String((phase3Candidates[aiResult.matchedIndex] as any).notion_id)]
            : undefined
      };

      if (aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65) {
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
            title
          }
        };

        // Notinha #1 (final): persistDecision deve usar o MESMO conjunto do evidenceKey/Phase3
        persistDecision(cache, inputUrl, out, evidenceKey, phase3Candidates);
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
          pageIds: phase2Candidates.map((c: any) => String(c.notion_id))
        }
      };

      persistDecision(cache, inputUrl, out, evidenceKey, phase3Candidates);
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
      debug
    };

    persistDecision(cache, inputUrl, out, evidenceKey, phase3Candidates);
    emit(out);
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Erro fatal:');
    console.error(err);
    process.exit(1);
  }

})();
