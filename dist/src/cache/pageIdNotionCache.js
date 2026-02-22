// src/cache/pageIdNotionCache.ts
//
// Cache por pageId (Notion live).
// Objetivo: quando a Phase 3 buscar detalhes no Notion por notion_id,
// a gente salva aqui e evita repetir chamadas enquanto o cache estiver "fresco" (TTL).
//
// Arquivo gerado: .cache/notion-page-cache.v1.json
//
// Observação: este cache NÃO é "por URL" e NÃO depende do snapshot pra ser válido.
// Ele é por pageId (notion_id). Se quiser amarrar ao snapshot, dá pra guardar a versão
// só por debug — mas não invalida automaticamente.
import fs from 'fs';
import path from 'path';
import { ensureCacheDir, atomicWriteJson, nowMs, isExpired, } from "../utils/cacheIo.js";
// DEPOIS
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'notion-page-cache.v1.json');
// Um TTL “safe” (ajuste depois): 7 dias.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// remove ensureCacheDir local e now(), use nowMs()
//
// Substitua todas as chamadas a `now()` por `nowMs()`.
// Troque writeJsonAtomic por atomicWriteJson direto:
function writeJsonAtomic(filePath, data) {
    atomicWriteJson(filePath, data);
}
export class PageIdNotionCache {
    state;
    constructor(state) {
        this.state = state;
    }
    static load(opts) {
        ensureCacheDir();
        const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        try {
            const raw = fs.readFileSync(CACHE_FILE, "utf-8");
            const parsed = JSON.parse(raw);
            // Se arquivo estiver zoado/incompatível, recomeça limpo
            if (parsed.schemaVersion !== "notion-page-cache.v1" || !parsed.entries) {
                return new PageIdNotionCache({
                    schemaVersion: "notion-page-cache.v1",
                    snapshotVersion: opts?.snapshotVersion,
                    ttlMs,
                    entries: {},
                });
            }
            const state = {
                schemaVersion: "notion-page-cache.v1",
                snapshotVersion: opts?.snapshotVersion ?? parsed.snapshotVersion,
                ttlMs: typeof parsed.ttlMs === "number" ? parsed.ttlMs : ttlMs,
                entries: parsed.entries,
            };
            // Atualiza TTL se o caller passou outro (mantém flexível)
            state.ttlMs = ttlMs;
            const cache = new PageIdNotionCache(state);
            cache.pruneExpired();
            cache.save(); // persistimos prune
            return cache;
        }
        catch {
            return new PageIdNotionCache({
                schemaVersion: "notion-page-cache.v1",
                snapshotVersion: opts?.snapshotVersion,
                ttlMs,
                entries: {},
            });
        }
    }
    save() {
        writeJsonAtomic(CACHE_FILE, this.state);
    }
    /** Remove entradas vencidas (TTL). */
    pruneExpired() {
        const ttlMs = this.state.ttlMs;
        for (const [pageId, entry] of Object.entries(this.state.entries)) {
            if (isExpired(entry.fetchedAt, ttlMs)) {
                delete this.state.entries[pageId];
            }
        }
    }
    /** Retorna entrada se ainda estiver fresca; senão retorna null (e já remove do cache). */
    get(pageId) {
        const key = String(pageId || "").trim();
        if (!key)
            return null;
        const entry = this.state.entries[key];
        if (!entry)
            return null;
        if (isExpired(entry.fetchedAt, this.state.ttlMs)) {
            delete this.state.entries[key];
            return null;
        }
        return entry;
    }
    /**
     * Retorna entrada apenas se, além de fresca, ela não estiver "mais velha"
     * que um lastEditedTime conhecido.
     *
     * Use isso quando você souber o last_edited_time do snapshot e quiser garantir
     * que o live cache não está atrasado.
     */
    getIfUpToDate(pageId, minLastEditedTimeISO) {
        const entry = this.get(pageId);
        if (!entry)
            return null;
        if (!minLastEditedTimeISO)
            return entry;
        if (!entry.lastEditedTime)
            return null;
        const min = Date.parse(minLastEditedTimeISO);
        const got = Date.parse(entry.lastEditedTime);
        // Se não der pra parsear, não bloqueia (fallback permissivo)
        if (!Number.isFinite(min) || !Number.isFinite(got))
            return entry;
        return got >= min ? entry : null;
    }
    /** Salva/atualiza uma página (sempre renova fetchedAt). */
    set(page) {
        const pageId = String(page.pageId || "").trim();
        if (!pageId) {
            throw new Error("PageIdNotionCache.set: pageId vazio");
        }
        const entry = {
            ...page,
            pageId,
            fetchedAt: nowMs(),
        };
        this.state.entries[pageId] = entry;
        return entry;
    }
    /** Para debug/telemetria: quantas entradas ainda estão válidas */
    size() {
        this.pruneExpired();
        return Object.keys(this.state.entries).length;
    }
}
