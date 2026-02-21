// src/cache/aiDecisionCache.ts
//
// Cache de decisões do Phase 3 (IA / Notion-live no futuro) por EVIDENCE KEY.
// - Chave: evidenceKey (string) — gerada por CacheEngine.buildEvidenceKey(...)
// - Invalida automaticamente quando snapshotVersion muda
// - Invalida automaticamente quando policyVersion muda
//
// Observação: este cache NÃO é “por URL”. É “por evidência” (assinatura do caso).
// URL cache determinístico fica em outro lugar (Phase 0/0.5/REJECTED_404).

import fs from 'fs';
import path from 'path';
import {
  ensureCacheDir,
  safeReadJson,
  atomicWriteJson,
} from '../utils/cacheIo.js';

import type { AnalyzerResultStatus, PhaseResolved } from "../domain/analyzerJsonOutput.js";

export interface AiDecisionCacheEntry {
  result: AnalyzerResultStatus;
  phaseResolved: PhaseResolved;
  reason: string;

  // quando FOUND
  chosenNotionId?: string;

  // opcional: telemetria para debug
  confidence?: number; // 0..1
  model?: string;

  timestamp: number; // epoch ms
}

type AiDecisionCacheFile = {
  schemaVersion: 1;
  snapshotVersion: string;
  policyVersion: string;
  entries: Record<string, AiDecisionCacheEntry>;
};

// DEPOIS
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'ai-decision-cache.v1.json');

// Segurança: evita crescimento infinito
const MAX_ENTRIES = 4000;

function emptyFile(snapshotVersion: string, policyVersion: string): AiDecisionCacheFile {
  return {
    schemaVersion: 1,
    snapshotVersion,
    policyVersion,
    entries: {},
  };
}

function pruneIfNeeded(file: AiDecisionCacheFile): void {
  const keys = Object.keys(file.entries);
  if (keys.length <= MAX_ENTRIES) return;

  const sorted = keys
    .map((k) => ({ k, t: file.entries[k]?.timestamp ?? 0 }))
    .sort((a, b) => a.t - b.t);

  const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
  for (const item of toRemove) delete file.entries[item.k];
}

export class AiDecisionCache {
  private data: AiDecisionCacheFile;

  private constructor(data: AiDecisionCacheFile) {
    this.data = data;
  }

  static load(snapshotVersion: string, policyVersion: string): AiDecisionCache {
    ensureCacheDir();

    const parsed = safeReadJson(CACHE_FILE) as Partial<AiDecisionCacheFile> | null;

    // Se não existe ou tá inválido
    if (!parsed || typeof parsed !== "object") {
      return new AiDecisionCache(emptyFile(snapshotVersion, policyVersion));
    }

    // Schema
    if (parsed.schemaVersion !== 1) {
      return new AiDecisionCache(emptyFile(snapshotVersion, policyVersion));
    }

    // Invalidação por versão
    const sameSnapshot = parsed.snapshotVersion === snapshotVersion;
    const samePolicy = parsed.policyVersion === policyVersion;

    if (!sameSnapshot || !samePolicy) {
      return new AiDecisionCache(emptyFile(snapshotVersion, policyVersion));
    }

    const entries =
      parsed.entries && typeof parsed.entries === "object"
        ? (parsed.entries as Record<string, AiDecisionCacheEntry>)
        : {};

    return new AiDecisionCache({
      schemaVersion: 1,
      snapshotVersion,
      policyVersion,
      entries,
    });
  }

  get(evidenceKey: string): AiDecisionCacheEntry | null {
    if (!evidenceKey) return null;
    return this.data.entries[evidenceKey] ?? null;
  }

  set(
    evidenceKey: string,
    entry: Omit<AiDecisionCacheEntry, "timestamp"> & { timestamp?: number }
  ): void {
    if (!evidenceKey) return;

    this.data.entries[evidenceKey] = {
      ...entry,
      timestamp: entry.timestamp ?? Date.now(),
    };

    pruneIfNeeded(this.data);
  }

  save(): void {
    atomicWriteJson(CACHE_FILE, this.data);
  }

  clear(): void {
    this.data.entries = {};
  }

  size(): number {
    return Object.keys(this.data.entries).length;
  }
}