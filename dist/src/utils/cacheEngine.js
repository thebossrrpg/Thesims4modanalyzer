// src/utils/cacheEngine.ts (BETA)
// Cache Engine alinhado com o que decidimos:
//
// ✅ 3 caches diferentes (num arquivo só):
//   1) urlCache            -> atalhos por URL (Phase 0 / 0.5 / REJECTED_404)
//   2) notionPageCache     -> dados do Notion LIVE por notion_id (Phase 3), com TTL + last_edited_time
//   3) decisionCache       -> decisões por "assinatura de evidência" (Identity + candidatos + policy + carimbo)
//
// ✅ NÃO cachear decisão por URL (URL muda, evidência pode ser igual)
// ✅ Remover ruído ("v2", "version 2") do texto usado na assinatura
// ✅ Status oficiais: FOUND | AMBIGUOUS | NOTFOUND | REJECTED_404
//
// Observações importantes:
// - SnapshotVersion só invalida urlCache e decisionCache.
// - notionPageCache NÃO depende do snapshot, então não é apagado quando snapshot muda.
// - "creator" na Identity é opcional e, por padrão, NÃO entra na assinatura (pode ser barulho/falso positivo).
// - Phase 2: NOTFOUND deve retornar no máximo TOP 5 candidatos fracos (isso não é do cache, mas este engine suporta).
//
// Uso típico:
//   const cache = CacheEngine.load(snapshotVersion);
//   const urlHit = cache.getUrlDecision(url);
//   const evidenceKey = cache.buildEvidenceKey(identity, candidates, policyVersion, notionStamp?);
//   const decisionHit = cache.getDecision(evidenceKey);
//   const pageHit = cache.getNotionPage(notionId, { expectedLastEditedTime? });
//   cache.setNotionPage(entry); cache.setDecision(evidenceKey, decision); cache.save();
//
// ---------------------------------------------------------
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { canonicalizeUrlKey, ensureCacheDir, safeReadJson, atomicWriteJson, safeUnlink, isExpired, nowMs, CACHE_DIR, } from "./cacheIo.js";
// -------------------------
// Arquivo em disco
// -------------------------
const CACHEDIR = path.resolve(process.cwd(), ".cache");
const CACHEFILE = path.join(CACHEDIR, "lookup-cache.v2.json");
// SUBSTITUI safeWriteJson por atomicWriteJson onde for usado:
function safeWriteJson(filePath, data) {
    atomicWriteJson(filePath, data);
}
function isCacheV2(x) {
    return (x &&
        typeof x === "object" &&
        x.version === 2 &&
        x.urlCache &&
        typeof x.urlCache === "object" &&
        x.notionPageCache &&
        typeof x.notionPageCache === "object" &&
        x.decisionCache &&
        typeof x.decisionCache === "object");
}
// -------------------------
// Normalização / hashing
// -------------------------
function stableJsonStringify(obj) {
    const seen = new WeakSet();
    const sort = (x) => {
        if (x === null || typeof x !== "object")
            return x;
        if (seen.has(x))
            return "[Circular]";
        seen.add(x);
        if (Array.isArray(x))
            return x.map(sort);
        const keys = Object.keys(x).sort();
        const out = {};
        for (const k of keys)
            out[k] = sort(x[k]);
        return out;
    };
    return JSON.stringify(sort(obj));
}
function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}
function stripNonDiscriminativeNoise(s) {
    let out = s.toLowerCase().trim();
    out = out.replace(/\s+/g, " ");
    // remove versões
    out = out.replace(/\b(v|ver|version)\s*\d+(\.\d+)*\b/g, "").trim();
    // remove etiquetas genéricas (ajuste se quiser)
    out = out.replace(/\b(updated|final|new|latest)\b/g, "").trim();
    out = out.replace(/\s+/g, " ");
    return out;
}
function quantizeScore(score) {
    // evita cache-miss por barulho de ponto flutuante
    return Math.round(score * 1000) / 1000;
}
export function getUrlKey(url) {
    // Normalização mínima. Se quiser, pode remover query params inúteis depois.
    return url.trim().toLowerCase();
}
export function getNotionId(p) {
    if (!p?.notion_id || typeof p.notion_id !== "string") {
        throw new Error("NotionPage sem notion_id: não dá pra cachear por página.");
    }
    return p.notion_id;
}
// -------------------------
// Engine
// -------------------------
export class CacheEngine {
    cache;
    constructor(cache) {
        this.cache = cache;
    }
    // ---- load/save ----
    static load(snapshotVersion) {
        ensureCacheDir();
        const raw = safeReadJson(CACHEFILE);
        if (!raw || !isCacheV2(raw)) {
            const fresh = {
                version: 2,
                snapshotVersion,
                urlCache: {},
                notionPageCache: {},
                decisionCache: {},
            };
            return new CacheEngine(fresh);
        }
        const loaded = raw;
        // Se snapshot mudou: invalida só o que depende do snapshot
        if (snapshotVersion &&
            loaded.snapshotVersion &&
            loaded.snapshotVersion !== snapshotVersion) {
            const migrated = {
                version: 2,
                snapshotVersion,
                urlCache: {}, // atalhos por URL podem ficar incoerentes
                notionPageCache: loaded.notionPageCache, // mantém (independente do snapshot)
                decisionCache: {}, // decisões podem ter sido geradas com candidatos antigos
            };
            return new CacheEngine(migrated);
        }
        loaded.snapshotVersion = snapshotVersion ?? loaded.snapshotVersion;
        return new CacheEngine(loaded);
    }
    save() {
        safeWriteJson(CACHEFILE, this.cache);
    }
    // Útil pra debug/teste
    exportRaw() {
        return this.cache;
    }
    // ---- URL Cache (Phase 0/0.5 e REJECTED_404) ----
    getUrlDecision(rawUrl) {
        const key = canonicalizeUrlKey(rawUrl);
        if (!key)
            return null;
        return this.cache.urlCache[key] ?? null;
    }
    setUrlDecision(rawUrl, entry) {
        const key = canonicalizeUrlKey(rawUrl);
        if (!key)
            return;
        this.cache.urlCache[key] = {
            ...entry,
            urlKey: key, // importante: armazenar o key canônico
        };
    }
    // ---- Notion Page Cache (Phase 3 live) ----
    // A lógica:
    // - Se existir entry no cache e ainda estiver no TTL -> retorna.
    // - Se você fornecer expectedLastEditedTime e não bater -> invalida (retorna null).
    // - Se não fornecer expectedLastEditedTime, TTL é o fallback.
    getNotionPage(notionId, opts) {
        const entry = this.cache.notionPageCache[notionId];
        if (!entry)
            return null;
        const now = opts?.now ?? Date.now();
        // Se caller sabe o last_edited_time live esperado e o cache diverge, invalida.
        if (opts?.expectedLastEditedTime &&
            entry.last_edited_time &&
            entry.last_edited_time !== opts.expectedLastEditedTime) {
            return null;
        }
        const age = now - entry.fetchedAt;
        if (age > entry.ttlMs)
            return null;
        return entry;
    }
    setNotionPage(entry) {
        this.cache.notionPageCache[entry.notion_id] = entry;
    }
    // Conveniência: cria entrada a partir de dados live
    makeNotionPageEntry(params) {
        return {
            notion_id: params.notionId,
            data: params.data,
            last_edited_time: params.lastEditedTime,
            ttlMs: params.ttlMs ?? 24 * 60 * 60 * 1000,
            fetchedAt: params.now ?? Date.now(),
        };
    }
    // ---- Decision Cache (por evidência) ----
    getDecision(evidenceKey) {
        return this.cache.decisionCache[evidenceKey] ?? null;
    }
    setDecision(evidenceKey, entry) {
        this.cache.decisionCache[evidenceKey] = { ...entry, evidenceKey };
    }
    // ---- Evidence Key (a parte mais importante) ----
    //
    // A chave muda só quando muda a capacidade de decidir.
    // - não usa URL
    // - remove "v2"/"version 2" etc
    // - candidatos entram por notion_id (ordenados)
    // - notionStamp opcional: notion_id -> last_edited_time (ou outro carimbo live)
    buildEvidenceKey(params) {
        const primaryName = params.identity.pageTitle ??
            params.identity.ogTitle ??
            params.identity.urlSlug ??
            "";
        const identityKeyMaterial = {
            domain: stripNonDiscriminativeNoise(params.identity.domain ?? ""),
            name: stripNonDiscriminativeNoise(primaryName),
            slug: stripNonDiscriminativeNoise(params.identity.urlSlug ?? ""),
            blocked: !!params.identity.isBlocked,
            // creator da Identity só entra se você tiver certeza que é confiável
            creator: params.includeCreatorInKey && params.identity.creator
                ? stripNonDiscriminativeNoise(params.identity.creator)
                : undefined,
        };
        const candidatesKeyMaterial = [...params.candidates]
            .map(p => ({
            notion_id: getNotionId(p),
            score: params.includeCandidateScores && typeof p._score === "number"
                ? quantizeScore(p._score)
                : undefined,
        }))
            .sort((a, b) => a.notion_id.localeCompare(b.notion_id));
        const payload = {
            policyVersion: params.policyVersion,
            identity: identityKeyMaterial,
            candidates: candidatesKeyMaterial,
            notionStamp: params.notionStamp ?? undefined,
        };
        return sha256(stableJsonStringify(payload));
    }
    // ---- Helpers ----
    makeDecisionEntry(params) {
        const candidateNotionIds = params.candidates
            ? params.candidates.map(getNotionId)
            : undefined;
        const urlKey = params.url ? getUrlKey(params.url) : undefined;
        return {
            result: params.result,
            reason: params.reason,
            phaseResolved: params.phaseResolved,
            timestamp: Date.now(),
            urlKey,
            evidenceKey: params.evidenceKey,
            chosenNotionId: params.chosenNotionId,
            candidateNotionIds,
        };
    }
}
