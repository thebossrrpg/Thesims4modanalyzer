// src/utils/cache.ts
//
// Orquestrador de caches (camada fina).
//
// Objetivo:
// - Centralizar as regras de cache num lugar só (pra main.ts ficar limpo)
// - Unificar 3 caches com papéis diferentes:
//
//   1) CacheEngine  -> URL cache + Decision/Evidence cache (assinatura)
//   2) AiDecisionCache -> (opcional) decisões de Phase 3 por evidenceKey
//      (se você já migrou tudo pro CacheEngine, pode nem usar)
//   3) PageIdNotionCache -> Notion live por pageId (TTL)
//
// Regra importante (a “notinha” que você achou):
// - URL cache só grava quando for determinístico:
//   REJECTED_404, PHASE_0, PHASE_0_5
//
// - Evidence cache grava quando existir evidenceKey
//
// Este arquivo NÃO faz IO de snapshot.json; ele só recebe snapshotVersion/policyVersion
// e devolve helpers para o pipeline.
import { CacheEngine } from "./cacheEngine.js";
// Se você já preencheu esses arquivos e quer usá-los separadamente.
// Se não quiser usar AiDecisionCache agora, deixe importado mas não instanciado.
import { AiDecisionCache } from "../cache/aiDecisionCache.js";
import { PageIdNotionCache } from "../cache/pageIdNotionCache.js";
export function initCaches(policy) {
    const engine = CacheEngine.load(policy.snapshotVersion);
    // AiDecisionCache invalida com snapshot+policy internamente (arquivo próprio)
    const ai = AiDecisionCache.load(policy.snapshotVersion, policy.policyVersion);
    // Notion live cache NÃO deve depender de snapshot (só TTL), mas guardamos pra debug
    const notionLive = PageIdNotionCache.load({ snapshotVersion: policy.snapshotVersion });
    return { policy, engine, ai, notionLive };
}
/** Converte entrada do CacheEngine (decision entry) para o tipo local. */
function coerceEngineEntry(entry) {
    return {
        result: entry.result,
        phaseResolved: entry.phaseResolved,
        reason: String(entry.reason ?? ""),
        chosenNotionId: entry.chosenNotionId ? String(entry.chosenNotionId) : undefined,
        evidenceKey: entry.evidenceKey ? String(entry.evidenceKey) : undefined,
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now()
    };
}
/** Determinístico = pode cachear por URL. */
export function isDeterministicPhase(phaseResolved) {
    return (phaseResolved === "REJECTED_404" ||
        phaseResolved === "PHASE_0" ||
        phaseResolved === "PHASE_0_5");
}
/** Cria a evidenceKey padrão (assinatura de evidência). */
export function buildEvidenceKey(caches, args) {
    return caches.engine.buildEvidenceKey({
        identity: args.identity,
        candidates: args.candidates,
        policyVersion: args.policyVersion ?? caches.policy.policyVersion
    });
}
/** Leitura rápida: URL cache (só o que o CacheEngine já guardou). */
export function getUrlCacheHit(caches, inputUrl) {
    const hit = caches.engine.getUrlDecision(inputUrl);
    return hit ? coerceEngineEntry(hit) : null;
}
/** Leitura rápida: evidence cache (CacheEngine). */
export function getEvidenceCacheHit(caches, evidenceKey) {
    const hit = caches.engine.getDecision(evidenceKey);
    return hit ? coerceEngineEntry(hit) : null;
}
/**
 * Persistência padronizada.
 *
 * Regra:
 * 1) URL cache: só determinístico (Phase 0 / 0.5 / REJECTED_404)
 * 2) Evidence cache: se houver evidenceKey (Phase 2/3)
 *
 * Observação:
 * - Você pode decidir guardar também no AiDecisionCache (arquivo separado)
 *   por redundância/compat, mas idealmente um só manda.
 */
export function persistDecision(caches, args) {
    const status = args.out.status;
    const phaseResolved = args.out.phaseResolved;
    const chosenNotionId = args.out.found?.pageId;
    const entry = caches.engine.makeDecisionEntry({
        result: status,
        reason: args.out.reason ?? "",
        phaseResolved,
        url: args.inputUrl,
        evidenceKey: args.evidenceKey,
        chosenNotionId,
        candidates: args.candidates ?? []
    });
    // 1) URL cache apenas se determinístico
    if (isDeterministicPhase(phaseResolved)) {
        caches.engine.setUrlDecision(args.inputUrl, entry);
    }
    // 2) Evidence cache quando houver key
    if (args.evidenceKey) {
        caches.engine.setDecision(args.evidenceKey, entry);
        // opcional: também gravar no AiDecisionCache (arquivo separado)
        // Isso é útil se você quer manter compat com versões anteriores.
        caches.ai.set(args.evidenceKey, {
            result: status,
            phaseResolved,
            reason: args.out.reason ?? "",
            chosenNotionId: chosenNotionId ?? undefined,
            confidence: args.aiConfidence
        });
        caches.ai.save();
    }
    caches.engine.save();
}
/**
 * Utilitário: hidratar "found" quando você só tem chosenNotionId.
 * (Isso resolve aquele comportamento feio de mostrar pageId como "título"
 * quando veio do URL cache.)
 */
export function hydrateFoundFromCandidates(notionId, candidates, getNotionPageUrl) {
    const match = candidates.find((c) => String(c.notion_id) === String(notionId));
    const title = match
        ? String(match.title ?? match.filename ?? match.url ?? notionId)
        : String(notionId);
    return {
        pageId: String(notionId),
        pageUrl: getNotionPageUrl(String(notionId), title),
        title
    };
}
