// src/main.ts

import { analyzeUrl } from "./phase1/analyzeUrl.js";
import { searchNotionCache } from "./phase2/searchNotionCache.js";
import { aiDisambiguate, isIdentityValidForAI } from "./phase3/aiDisambiguate.js";
import { getNotionPageUrl } from "./utils/notion.js";
import { CacheEngine } from "./utils/cacheEngine.js";

import fs from "fs";

import type { NotionCacheSnapshot, NotionPage } from "./domain/snapshot.js";
import type { Identity, UnfurlVia } from "./domain/identity.js";

import type {
  AnalyzerJsonOutput,
  DebugExpander,
  ProviderUsed,
  CandidateDebug,
  AnalyzerResultStatus,
  PhaseResolved
} from "./domain/analyzerJsonOutput.js";

const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find((a) => !a.startsWith("--"));
const flagJson = rawArgs.includes("--json");

const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────

function emit(output: AnalyzerJsonOutput) {
  if (flagJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHumanSummary(output);
  }
}

function printHumanSummary(out: AnalyzerJsonOutput) {
  console.log(`\n🔗 ${out.inputUrl}`);
  console.log(`📌 Resultado: ${out.status}`);
  if (out.reason) console.log(`🧠 Motivo: ${out.reason}`);

  if (out.status === "FOUND" && out.found) {
    console.log(`✅ Match: ${out.found.title ?? out.found.pageId}`);
    if (out.found.pageUrl) console.log(`🗂️ Notion: ${out.found.pageUrl}`);
  }

  if (out.status === "AMBIGUOUS" && out.ambiguous) {
    console.log(`⚠️ Candidatos: ${out.ambiguous.pageIds.join(", ")}`);
  }

  if (out.status === "REJECTED_404") {
    const r = out.debug.validation.rejected404Reason ?? "(sem motivo)";
    console.log(`⛔ URL rejeitada: ${r}`);
  }

  console.log("");
}

// ─────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────

function loadSnapshot(path: string): NotionCacheSnapshot {
  const raw = fs.readFileSync(path, "utf-8");
  return JSON.parse(raw) as NotionCacheSnapshot;
}

function urlLookupKeys(rawUrl: string) {
  if (!rawUrl) return [];
  const canonical = rawUrl.trim();
  const noScheme = canonical.replace(/^https?:\/\//i, "");
  const compact = noScheme.replace(/[./]/g, "");
  return [canonical, noScheme, compact];
}

function extractFinalSlug(rawUrl: string): { slug: string; domain: string } | null {
  try {
    const url = new URL(rawUrl);
    const domain = url.hostname.replace(/^www\./i, "").toLowerCase();

    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);

    if (!parts.length) return null;

    const slug = parts[parts.length - 1]
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, "");

    if (!slug) return null;

    return { slug, domain };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Debug/schema mapping helpers
// ─────────────────────────────────────────────────────────────

function mapUnfurlViaToProvider(via: UnfurlVia): ProviderUsed {
  switch (via) {
    case "og_web_scraper":
      return "html";
    case "local_ogs":
      return "localOgs";
    case "iframely":
      return "iframely";
    default:
      return "html";
  }
}

function candidatesToDebugTop5(candidates: NotionPage[] | undefined): CandidateDebug[] {
  if (!candidates || candidates.length === 0) return [];
  return candidates.slice(0, 5).map((c: any) => ({
    title: (c.title ?? c.filename ?? c.url ?? "Unknown") as string,
    pageId: (c.notion_id ?? "") as string,
    score: typeof c._score === "number" ? c._score : 0
  }));
}

// CacheEngine usa phaseResolved livre ("phase0", "phase0.5", "phase2"...)
// JSON usa enum ("PHASE_0", "PHASE_0_5"...)

function toCachePhaseResolved(phase: PhaseResolved): string {
  switch (phase) {
    case "PHASE_0":
      return "phase0";
    case "PHASE_0_5":
      return "phase0.5";
    case "PHASE_2":
      return "phase2";
    case "PHASE_3":
      return "phase3";
    case "REJECTED_404":
      return "rejected_404";
    default:
      return "phase2";
  }
}

function fromCachePhaseResolved(phase: string | undefined): PhaseResolved {
  const p = (phase ?? "").toLowerCase().trim();

  if (p === "phase0") return "PHASE_0";
  if (p === "phase0.5" || p === "phase0_5") return "PHASE_0_5";
  if (p === "phase2") return "PHASE_2";
  if (p === "phase3") return "PHASE_3";
  if (p === "rejected_404" || p === "rejected404") return "REJECTED_404";

  // fallback seguro
  return "PHASE_2";
}

// Converte DecisionEntry (CacheEngine) => AnalyzerJsonOutput (seu schema UI)
function decisionEntryToAnalyzerOutput(params: {
  entry: any;
  inputUrl: string;
  debug: DebugExpander;
  meta?: AnalyzerJsonOutput["meta"];
  // opcional: para hidratar displayName com candidatos atuais
  candidatesForHydration?: NotionPage[];
}): AnalyzerJsonOutput {
  const { entry, inputUrl, debug, meta, candidatesForHydration } = params;

  const status = entry?.result as AnalyzerResultStatus;
  const phaseResolved = fromCachePhaseResolved(entry?.phaseResolved);
  const reason = entry?.reason as string | undefined;

  const out: AnalyzerJsonOutput = {
    startedAt,
    inputUrl,
    status,
    phaseResolved,
    reason,
    meta,
    debug
  };

  if (status === "FOUND" && entry?.chosenNotionId) {
    const notionId = String(entry.chosenNotionId);

    // tenta hidratar title
    let title: string | undefined = undefined;
    if (candidatesForHydration?.length) {
      const match = candidatesForHydration.find((c: any) => c.notion_id === notionId);
      if (match) title = match.title ?? match.filename ?? match.url ?? match.notion_id;
    }

    out.found = {
      pageId: notionId,
      pageUrl: getNotionPageUrl(notionId, title ?? notionId),
      title: title ?? notionId
    };
  }

  if (status === "AMBIGUOUS") {
    const pageIds: string[] =
      (entry?.candidateNotionIds ?? [])
        .filter(Boolean)
        .map(String);

    if (pageIds.length) out.ambiguous = { pageIds };
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

(async () => {
  // Debug expander base (sempre existe)
  const debug: DebugExpander = {
    validation: {
      isValidHttpUrl: Boolean(inputUrl && /^https?:\/\//i.test(inputUrl))
    }
  };

  // Validação mínima (http[s])
  if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
    debug.validation.isValidHttpUrl = false;
    debug.validation.rejected404Reason = "url_not_http";

    const out: AnalyzerJsonOutput = {
      startedAt,
      inputUrl: inputUrl ?? "",
      status: "REJECTED_404",
      phaseResolved: "REJECTED_404",
      reason: "URL não é http(s)",
      debug
    };

    // ✅ urlCache permitido para REJECTED_404 (atalho por URL)
    try {
      const snapshot = loadSnapshot("./snapshot.json");
      const snapshotVersion =
        snapshot.meta?.version ??
        String(Object.keys(snapshot.notion_pages ?? {}).length);

      const cache = CacheEngine.load(snapshotVersion);

      const entry = cache.makeDecisionEntry({
        result: out.status,
        reason: out.reason ?? "",
        phaseResolved: toCachePhaseResolved(out.phaseResolved),
        url: inputUrl ?? ""
      });

      cache.setUrlDecision(inputUrl ?? "", entry);
      cache.save();
    } catch {
      // se der qualquer ruim no cache, não derruba o app
    }

    emit(out);
    process.exit(0);
  }

  try {
    // ═══════════════════════════════════════════════════════
    // SNAPSHOT + CACHE INIT
    // ═══════════════════════════════════════════════════════
    const snapshot: NotionCacheSnapshot = loadSnapshot("./snapshot.json");

    const snapshotVersion =
      snapshot.meta?.version ??
      String(Object.keys(snapshot.notion_pages ?? {}).length);

    const cache = CacheEngine.load(snapshotVersion);

    // ⚡ URL CACHE SHORT-CIRCUIT (somente atalhos por URL)
    const urlCacheHit = cache.getUrlDecision(inputUrl);
    if (urlCacheHit) {
      const cachedDebug: DebugExpander = {
        validation: { isValidHttpUrl: true }
      };

      const out = decisionEntryToAnalyzerOutput({
        entry: urlCacheHit,
        inputUrl,
        debug: cachedDebug,
        meta: { decisionCache: { hit: true, key: "url:" + inputUrl } }
      });

      emit(out);
      process.exit(0);
    }

    const notionPages: NotionPage[] = Object.values(snapshot.notion_pages ?? {});

    // ═══════════════════════════════════════════════════════
    // PHASE 0 — URL lookup exato
    // ═══════════════════════════════════════════════════════
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
      const title = phase0Match.title ?? phase0Match.filename ?? phase0Match.url ?? phase0Match.notion_id;

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: "FOUND",
        phaseResolved: "PHASE_0",
        reason: "Direct URL match in Notion snapshot (Phase 0)",
        debug,
        found: {
          pageId: phase0Match.notion_id,
          pageUrl: getNotionPageUrl(phase0Match.notion_id, title),
          title
        }
      };

      // ✅ urlCache permitido (Phase 0)
      const entry = cache.makeDecisionEntry({
        result: out.status,
        reason: out.reason ?? "",
        phaseResolved: toCachePhaseResolved(out.phaseResolved),
        url: inputUrl,
        chosenNotionId: out.found?.pageId
      });

      cache.setUrlDecision(inputUrl, entry);
      cache.save();

      emit(out);
      process.exit(0);
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 0.5 — Slug match
    // ═══════════════════════════════════════════════════════
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
      const title = phase05Match.title ?? phase05Match.filename ?? phase05Match.url ?? phase05Match.notion_id;

      const out: AnalyzerJsonOutput = {
        startedAt,
        inputUrl,
        status: "FOUND",
        phaseResolved: "PHASE_0_5",
        reason: "Slug match in Notion snapshot (Phase 0.5)",
        debug,
        found: {
          pageId: phase05Match.notion_id,
          pageUrl: getNotionPageUrl(phase05Match.notion_id, title),
          title
        }
      };

      // ✅ urlCache permitido (Phase 0.5)
      const entry = cache.makeDecisionEntry({
        result: out.status,
        reason: out.reason ?? "",
        phaseResolved: toCachePhaseResolved(out.phaseResolved),
        url: inputUrl,
        chosenNotionId: out.found?.pageId
      });

      cache.setUrlDecision(inputUrl, entry);
      cache.save();

      emit(out);
      process.exit(0);
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 1 — Identity
    // ═══════════════════════════════════════════════════════
    const identity: Identity = await analyzeUrl(inputUrl);

    debug.phase1 = {
      blocked: Boolean(identity.isBlocked),
      providersUsed: [mapUnfurlViaToProvider(identity.unfurlVia)],
      identity
    };

    // ═══════════════════════════════════════════════════════
    // PHASE 2 — Snapshot fuzzy
    // ═══════════════════════════════════════════════════════
    const phase2Result = await searchNotionCache(
      identity,
      snapshot.phase_2_cache?.pages ?? {}
    );

    const phase2Candidates = phase2Result.candidates ?? [];
    const candidatesCount =
      typeof (phase2Result.decision as any).phase2Candidates === "number"
        ? (phase2Result.decision as any).phase2Candidates
        : phase2Candidates.length;

    debug.phase2 = {
      candidatesCount,
      candidatesTop5: candidatesToDebugTop5(phase2Candidates)
    };

    // ═══════════════════════════════════════════════════════
    // AI DECISION CACHE (evidence-based short-circuit)
    // ═══════════════════════════════════════════════════════
    const policyVersion = "phase3-ai-v1";

    const evidenceKey = cache.buildEvidenceKey({
      identity,
      candidates: phase2Candidates,
      policyVersion
    });

    const decisionCacheHit = cache.getDecision(evidenceKey);
    if (decisionCacheHit) {
      const out = decisionEntryToAnalyzerOutput({
        entry: decisionCacheHit,
        inputUrl,
        debug,
        meta: { aiDecisionCache: { hit: true, key: evidenceKey } },
        candidatesForHydration: phase2Candidates
      });

      emit(out);
      process.exit(0);
    }

    // ═══════════════════════════════════════════════════════
    // Decide (Phase 2 resolve direto) ou tenta IA (Phase 3)
    // ═══════════════════════════════════════════════════════
    let finalOut: AnalyzerJsonOutput;

    if (phase2Result.decision.result === "FOUND") {
      const pageId = phase2Result.decision.notionId ?? "";
      const title = phase2Result.decision.displayName ?? pageId;

      finalOut = {
        startedAt,
        inputUrl,
        status: "FOUND",
        phaseResolved: "PHASE_2",
        reason: phase2Result.decision.reason,
        debug,
        found: {
          pageId,
          pageUrl: getNotionPageUrl(pageId, title),
          title
        }
      };
    } else {
      // PHASE 3 gates (igual seu main atual)
      const phase2Failed =
        phase2Result.decision.result === "NOTFOUND" ||
        phase2Result.decision.result === "AMBIGUOUS";

      const hasCandidates = phase2Candidates.length >= 2 && phase2Candidates.length <= 5;
      const hasValidIdentity = isIdentityValidForAI(identity);

      if (phase2Failed && hasCandidates && hasValidIdentity) {
        const aiResult = await aiDisambiguate(identity, phase2Candidates);

        debug.phase3 = {
          mode: "offline",
          finalCandidates:
            aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65
              ? 1
              : phase2Candidates.length,
          finalCandidatePageIds:
            aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65
              ? [String((phase2Candidates[aiResult.matchedIndex] as any).notion_id)]
              : undefined
        };

        if (aiResult.matchedIndex >= 0 && aiResult.confidence >= 0.65) {
          const matched: any = phase2Candidates[aiResult.matchedIndex];
          const title = matched.title ?? matched.filename ?? matched.url ?? matched.notion_id;

          finalOut = {
            startedAt,
            inputUrl,
            status: "FOUND",
            phaseResolved: "PHASE_3",
            reason: `🤖 AI match: ${aiResult.reason} (${(aiResult.confidence * 100).toFixed(0)}%)`,
            debug,
            found: {
              pageId: matched.notion_id,
              pageUrl: getNotionPageUrl(matched.notion_id, title),
              title
            }
          };
        } else {
          // não conseguiu escolher -> mantém AMBIGUOUS da Phase 2 (se for o caso), senão NOTFOUND
          if (phase2Result.decision.result === "AMBIGUOUS") {
            finalOut = {
              startedAt,
              inputUrl,
              status: "AMBIGUOUS",
              phaseResolved: "PHASE_2",
              reason: phase2Result.decision.reason,
              debug,
              ambiguous: {
                pageIds: phase2Candidates.map((c: any) => String(c.notion_id))
              }
            };
          } else {
            finalOut = {
              startedAt,
              inputUrl,
              status: "NOTFOUND",
              phaseResolved: "PHASE_2",
              reason: phase2Result.decision.reason,
              debug
            };
          }
        }
      } else {
        // sem IA: devolve Phase 2
        if (phase2Result.decision.result === "AMBIGUOUS") {
          finalOut = {
            startedAt,
            inputUrl,
            status: "AMBIGUOUS",
            phaseResolved: "PHASE_2",
            reason: phase2Result.decision.reason,
            debug,
            ambiguous: {
              pageIds: phase2Candidates.map((c: any) => String(c.notion_id))
            }
          };
        } else {
          finalOut = {
            startedAt,
            inputUrl,
            status: "NOTFOUND",
            phaseResolved: "PHASE_2",
            reason: phase2Result.decision.reason,
            debug
          };
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // SAVE decisionCache (evidence-based) — SEM urlCache aqui
    // ═══════════════════════════════════════════════════════
    const decisionEntry = cache.makeDecisionEntry({
      result: finalOut.status,
      reason: finalOut.reason ?? "",
      phaseResolved: toCachePhaseResolved(finalOut.phaseResolved),
      url: inputUrl,               // só pra auditoria (urlKey), não é usado na chave
      evidenceKey,
      chosenNotionId: finalOut.found?.pageId,
      candidates: phase2Candidates // vira candidateNotionIds
    });

    cache.setDecision(evidenceKey, decisionEntry);
    cache.save();

    emit(finalOut);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Erro fatal:");
    console.error(err);
    process.exit(1);
  }
})();
