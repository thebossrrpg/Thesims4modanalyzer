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
import { ensureCacheDir, safeReadJson, atomicWriteJson, } from '../utils/cacheIo.js';
// DEPOIS
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'ai-decision-cache.v1.json');
// Segurança: evita crescimento infinito
const MAX_ENTRIES = 4000;
function emptyFile(snapshotVersion, policyVersion) {
    return {
        schemaVersion: 1,
        snapshotVersion,
        policyVersion,
        entries: {},
    };
}
function pruneIfNeeded(file) {
    const keys = Object.keys(file.entries);
    if (keys.length <= MAX_ENTRIES)
        return;
    const sorted = keys
        .map((k) => ({ k, t: file.entries[k]?.timestamp ?? 0 }))
        .sort((a, b) => a.t - b.t);
    const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
    for (const item of toRemove)
        delete file.entries[item.k];
}
export class AiDecisionCache {
    data;
    constructor(data) {
        this.data = data;
    }
    static load(snapshotVersion, policyVersion) {
        ensureCacheDir();
        const parsed = safeReadJson(CACHE_FILE);
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
        const entries = parsed.entries && typeof parsed.entries === "object"
            ? parsed.entries
            : {};
        return new AiDecisionCache({
            schemaVersion: 1,
            snapshotVersion,
            policyVersion,
            entries,
        });
    }
    get(evidenceKey) {
        if (!evidenceKey)
            return null;
        return this.data.entries[evidenceKey] ?? null;
    }
    set(evidenceKey, entry) {
        if (!evidenceKey)
            return;
        this.data.entries[evidenceKey] = {
            ...entry,
            timestamp: entry.timestamp ?? Date.now(),
        };
        pruneIfNeeded(this.data);
    }
    save() {
        atomicWriteJson(CACHE_FILE, this.data);
    }
    clear() {
        this.data.entries = {};
    }
    size() {
        return Object.keys(this.data.entries).length;
    }
}
