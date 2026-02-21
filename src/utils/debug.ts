// src/utils/debug.ts
//
// Helpers de debug (somente formatação / mapeamento) para manter o main.ts limpo.
// Tudo aqui é "side-effect free": não lê arquivo, não escreve cache, não faz IO.
//
// Alinhado com:
// - src/domain/analyzerJsonOutput.ts (DebugExpander, DebugPhase25, DebugPhase3, CandidateDebug, ProviderUsed)
// - src/domain/identity.ts (UnfurlVia)
// - src/domain/snapshot.ts (NotionPage)

import type { UnfurlVia } from "../domain/identity.js";
import type { NotionPage } from "../domain/snapshot.js";
import type {
  CandidateDebug,
  DebugExpander,
  DebugPhase25,
  DebugPhase3,
  ProviderUsed,
} from "../domain/analyzerJsonOutput.js";

/**
 * Cria o esqueleto do debug com validação básica.
 * O main pode enriquecer depois (phase0, phase05, phase1, phase2, phase25, phase3).
 */
export function createBaseDebug(inputUrl?: string): DebugExpander {
  const isValidHttpUrl = Boolean(inputUrl && /^https?:\/\//i.test(inputUrl));
  return {
    validation: {
      isValidHttpUrl,
    },
  };
}

export function setRejected404(debug: DebugExpander, reason: string): void {
  debug.validation.isValidHttpUrl = false;
  debug.validation.rejected404Reason = reason;
}

/**
 * Mapeia a origem do unfurl (Identity.unfurlVia) para o "providerUsed"
 * usado no JSON de debug (contrato do analyzerJsonOutput).
 */
export function mapUnfurlViaToProvider(via: UnfurlVia): ProviderUsed {
  switch (via) {
    case "og_web_scraper":
      return "html";
    case "local_ogs":
      return "localOgs";
    case "iframely":
      return "iframely";
    case "none":
    default:
      return "html";
  }
}

/**
 * Converte NotionPage[] em CandidateDebug[] (top 5).
 * Observação: seu NotionPage suporta _score opcional, então a gente lê com segurança.
 */
export function candidatesToDebugTop5(candidates: NotionPage[]): CandidateDebug[] {
  return candidates.slice(0, 5).map((c: any) => ({
    title: String(c.title ?? c.filename ?? c.url ?? "Unknown"),
    pageId: String(c.notion_id ?? ""),
    score: typeof c._score === "number" ? c._score : 0,
  }));
}

/**
 * Builder para debug.phase25 no formato esperado pelo contrato.
 * selectionRule é um rótulo simples (ex.: "PLAN_TOP5", "SANITY_TOPK", "NONE").
 */
export function buildPhase25Debug(
  candidates: NotionPage[],
  selectionRule: DebugPhase25["selectionRule"]
): DebugPhase25 {
  return {
    candidatesCount: candidates.length,
    candidates: candidatesToDebugTop5(candidates),
    selectionRule,
  };
}

/**
 * Builder para debug.phase3 no formato esperado pelo contrato.
 * "mode": "offline" (IA stub) ou "notion_live" (futuro).
 */
export function buildPhase3Debug(params: {
  mode: DebugPhase3["mode"];
  finalCandidates: number;
  finalCandidatePageIds?: string[];
}): DebugPhase3 {
  return {
    mode: params.mode,
    finalCandidates: params.finalCandidates,
    finalCandidatePageIds: params.finalCandidatePageIds,
  };
}
