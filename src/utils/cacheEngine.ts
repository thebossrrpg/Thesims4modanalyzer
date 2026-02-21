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
import {
  ensureCacheDir,
  safeReadJson,
  atomicWriteJson,
} from '../utils/cacheIo.js';

import type { Identity } from "../domain/identity.js";
import type { NotionPage } from "../domain/snapshot.js";
import type { PhaseResolved } from "../domain/analyzerJsonOutput.js";

// -------------------------
// Tipos
// -------------------------

export type AnalyzerResult = "FOUND" | "AMBIGUOUS" | "NOTFOUND" | "REJECTED_404";

export type DecisionEntry = {
  result: AnalyzerResult;
  reason: string;
  phaseResolved: PhaseResolved;   // era: string
  timestamp: number;

  urlKey?: string;
  evidenceKey?: string;
  chosenNotionId?: string;
  candidateNotionIds?: string[];
};

export type UrlCacheEntry = DecisionEntry;

export type NotionPageCacheEntry = {
  notion_id: string;
  fetchedAt: number;
  ttlMs: number;

  // carimbo do Notion live
  last_edited_time?: string;

  // dados reduzidos (só o que você precisa pra desambiguar)
  // mantenha leve: título, creator, links, tags, etc.
  data: Record<string, unknown>;
};

export type CacheV2 = {
  version: 2;
  snapshotVersion?: string;

  urlCache: Record<string, UrlCacheEntry>;
  notionPageCache: Record<string, NotionPageCacheEntry>;
  decisionCache: Record<string, DecisionEntry>;
};

// -------------------------
// Arquivo em disco
// -------------------------

const CACHEDIR = path.resolve(process.cwd(), ".cache");
const CACHEFILE = path.join(CACHEDIR, "lookup-cache.v2.json");

// SUBSTITUI safeWriteJson por atomicWriteJson onde for usado:
function safeWriteJson(filePath: string, data: unknown): void {
  atomicWriteJson(filePath, data);
}


function isCacheV2(x: any): x is CacheV2 {
  return (
    x &&
    typeof x === "object" &&
    x.version === 2 &&
    x.urlCache &&
    typeof x.urlCache === "object" &&
    x.notionPageCache &&
    typeof x.notionPageCache === "object" &&
    x.decisionCache &&
    typeof x.decisionCache === "object"
  );
}

// -------------------------
// Normalização / hashing
// -------------------------

function stableJsonStringify(obj: unknown): string {
  const seen = new WeakSet<object>();

  const sort = (x: any): any => {
    if (x === null || typeof x !== "object") return x;
    if (seen.has(x)) return "[Circular]";
    seen.add(x);

    if (Array.isArray(x)) return x.map(sort);

    const keys = Object.keys(x).sort();
    const out: any = {};
    for (const k of keys) out[k] = sort(x[k]);
    return out;
  };

  return JSON.stringify(sort(obj));
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stripNonDiscriminativeNoise(s: string): string {
  let out = s.toLowerCase().trim();
  out = out.replace(/\s+/g, " ");

  // remove versões
  out = out.replace(/\b(v|ver|version)\s*\d+(\.\d+)*\b/g, "").trim();

  // remove etiquetas genéricas (ajuste se quiser)
  out = out.replace(/\b(updated|final|new|latest)\b/g, "").trim();

  out = out.replace(/\s+/g, " ");
  return out;
}

function quantizeScore(score: number): number {
  // evita cache-miss por barulho de ponto flutuante
  return Math.round(score * 1000) / 1000;
}

export function getUrlKey(url: string): string {
  // Normalização mínima. Se quiser, pode remover query params inúteis depois.
  return url.trim().toLowerCase();
}

export function getNotionId(p: NotionPage): string {
  if (!p?.notion_id || typeof p.notion_id !== "string") {
    throw new Error("NotionPage sem notion_id: não dá pra cachear por página.");
  }
  return p.notion_id;
}

// -------------------------
// Engine
// -------------------------

export class CacheEngine {
  private cache: CacheV2;

  private constructor(cache: CacheV2) {
    this.cache = cache;
  }

  // ---- load/save ----

  static load(snapshotVersion?: string): CacheEngine {
    ensureCacheDir();

    const raw = safeReadJson(CACHEFILE);
    if (!raw || !isCacheV2(raw)) {
      const fresh: CacheV2 = {
        version: 2,
        snapshotVersion,
        urlCache: {},
        notionPageCache: {},
        decisionCache: {},
      };
      return new CacheEngine(fresh);
    }

    const loaded: CacheV2 = raw;

    // Se snapshot mudou: invalida só o que depende do snapshot
    if (
      snapshotVersion &&
      loaded.snapshotVersion &&
      loaded.snapshotVersion !== snapshotVersion
    ) {
      const migrated: CacheV2 = {
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

  save(): void {
    safeWriteJson(CACHEFILE, this.cache);
  }

  // Útil pra debug/teste
  exportRaw(): CacheV2 {
    return this.cache;
  }

  // ---- URL Cache (Phase 0/0.5 e REJECTED_404) ----

  getUrlDecision(url: string): UrlCacheEntry | null {
    const key = getUrlKey(url);
    return this.cache.urlCache[key] ?? null;
  }

  setUrlDecision(url: string, entry: UrlCacheEntry): void {
    const key = getUrlKey(url);
    this.cache.urlCache[key] = { ...entry, urlKey: key };
  }

  // ---- Notion Page Cache (Phase 3 live) ----
  // A lógica:
  // - Se existir entry no cache e ainda estiver no TTL -> retorna.
  // - Se você fornecer expectedLastEditedTime e não bater -> invalida (retorna null).
  // - Se não fornecer expectedLastEditedTime, TTL é o fallback.

  getNotionPage(
    notionId: string,
    opts?: { now?: number; expectedLastEditedTime?: string }
  ): NotionPageCacheEntry | null {
    const entry = this.cache.notionPageCache[notionId];
    if (!entry) return null;

    const now = opts?.now ?? Date.now();

    // Se caller sabe o last_edited_time live esperado e o cache diverge, invalida.
    if (
      opts?.expectedLastEditedTime &&
      entry.last_edited_time &&
      entry.last_edited_time !== opts.expectedLastEditedTime
    ) {
      return null;
    }

    const age = now - entry.fetchedAt;
    if (age > entry.ttlMs) return null;

    return entry;
  }

  setNotionPage(entry: NotionPageCacheEntry): void {
    this.cache.notionPageCache[entry.notion_id] = entry;
  }

  // Conveniência: cria entrada a partir de dados live
  makeNotionPageEntry(params: {
    notionId: string;
    data: Record<string, unknown>;
    lastEditedTime?: string;
    ttlMs?: number; // default 24h
    now?: number;
  }): NotionPageCacheEntry {
    return {
      notion_id: params.notionId,
      data: params.data,
      last_edited_time: params.lastEditedTime,
      ttlMs: params.ttlMs ?? 24 * 60 * 60 * 1000,
      fetchedAt: params.now ?? Date.now(),
    };
  }

  // ---- Decision Cache (por evidência) ----

  getDecision(evidenceKey: string): DecisionEntry | null {
    return this.cache.decisionCache[evidenceKey] ?? null;
  }

  setDecision(evidenceKey: string, entry: DecisionEntry): void {
    this.cache.decisionCache[evidenceKey] = { ...entry, evidenceKey };
  }

  // ---- Evidence Key (a parte mais importante) ----
  //
  // A chave muda só quando muda a capacidade de decidir.
  // - não usa URL
  // - remove "v2"/"version 2" etc
  // - candidatos entram por notion_id (ordenados)
  // - notionStamp opcional: notion_id -> last_edited_time (ou outro carimbo live)

  buildEvidenceKey(params: {
    identity: Identity;
    candidates: NotionPage[]; // idealmente <= 5
    policyVersion: string;    // ex: "phase3-notion-live-v1"
    notionStamp?: Record<string, string>; // notion_id -> last_edited_time
    includeCreatorInKey?: boolean;        // default false
    includeCandidateScores?: boolean;     // default false (score costuma ser barulho)
  }): string {
    const primaryName =
      params.identity.pageTitle ??
      params.identity.ogTitle ??
      params.identity.urlSlug ??
      "";

    const identityKeyMaterial = {
      domain: stripNonDiscriminativeNoise(params.identity.domain ?? ""),
      name: stripNonDiscriminativeNoise(primaryName),
      slug: stripNonDiscriminativeNoise(params.identity.urlSlug ?? ""),
      blocked: !!params.identity.isBlocked,

      // creator da Identity só entra se você tiver certeza que é confiável
      creator:
        params.includeCreatorInKey && params.identity.creator
          ? stripNonDiscriminativeNoise(params.identity.creator)
          : undefined,
    };

    const candidatesKeyMaterial = [...params.candidates]
      .map(p => ({
        notion_id: getNotionId(p),
        score:
          params.includeCandidateScores && typeof p._score === "number"
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

  makeDecisionEntry(params: {
    result: AnalyzerResult;
    reason: string;
    phaseResolved: PhaseResolved;   // era: string
    url?: string;
    evidenceKey?: string;
    chosenNotionId?: string;
    candidates?: NotionPage[];
  }): DecisionEntry {
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
