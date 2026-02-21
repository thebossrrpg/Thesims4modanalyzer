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

import fs from "fs";
import path from "path";

export type NotionLivePage = {
  pageId: string;

  // Campos mínimos úteis pra Phase 3 “confirmar/desambiguar”
  title: string | null;
  creator: string | null;

  // URL canônica (opcional). Se você montar URL via helper, pode deixar null.
  url: string | null;

  // Última edição (string ISO do Notion, se você tiver isso)
  lastEditedTime: string | null;

  // Quando esse registro foi buscado “ao vivo”
  fetchedAt: number;
};

type NotionPageCacheFile = {
  schemaVersion: "notion-page-cache.v1";

  // Só pra debug (não invalida)
  snapshotVersion?: string;

  // TTL global do arquivo (ms)
  ttlMs: number;

  // pageId -> NotionLivePage
  entries: Record<string, NotionLivePage>;
};

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "notion-page-cache.v1.json");

// Um TTL “safe” (ajuste depois): 7 dias.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function now(): number {
  return Date.now();
}

function normalizePageId(pageId: string): string {
  return String(pageId || "").trim();
}

function isFresh(entry: NotionLivePage, ttlMs: number): boolean {
  return now() - entry.fetchedAt <= ttlMs;
}

// Escrita atômica: escreve em tmp e renomeia
function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureCacheDir();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export class PageIdNotionCache {
  private state: NotionPageCacheFile;

  private constructor(state: NotionPageCacheFile) {
    this.state = state;
  }

  static load(opts?: { ttlMs?: number; snapshotVersion?: string }): PageIdNotionCache {
    ensureCacheDir();

    const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

    try {
      const raw = fs.readFileSync(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<NotionPageCacheFile>;

      // Se arquivo estiver zoado/incompatível, recomeça limpo
      if (parsed.schemaVersion !== "notion-page-cache.v1" || !parsed.entries) {
        return new PageIdNotionCache({
          schemaVersion: "notion-page-cache.v1",
          snapshotVersion: opts?.snapshotVersion,
          ttlMs,
          entries: {},
        });
      }

      const state: NotionPageCacheFile = {
        schemaVersion: "notion-page-cache.v1",
        snapshotVersion: opts?.snapshotVersion ?? parsed.snapshotVersion,
        ttlMs: typeof parsed.ttlMs === "number" ? parsed.ttlMs : ttlMs,
        entries: parsed.entries as Record<string, NotionLivePage>,
      };

      // Atualiza TTL se o caller passou outro (mantém flexível)
      state.ttlMs = ttlMs;

      const cache = new PageIdNotionCache(state);
      cache.pruneExpired();
      cache.save(); // persistimos prune
      return cache;
    } catch {
      return new PageIdNotionCache({
        schemaVersion: "notion-page-cache.v1",
        snapshotVersion: opts?.snapshotVersion,
        ttlMs,
        entries: {},
      });
    }
  }

  save(): void {
    writeJsonAtomic(CACHE_FILE, this.state);
  }

  /** Remove entradas vencidas (TTL). */
  pruneExpired(): void {
    const ttlMs = this.state.ttlMs;
    for (const [pageId, entry] of Object.entries(this.state.entries)) {
      if (!isFresh(entry, ttlMs)) {
        delete this.state.entries[pageId];
      }
    }
  }

  /** Retorna entrada se ainda estiver fresca; senão retorna null (e já remove do cache). */
  get(pageId: string): NotionLivePage | null {
    const key = normalizePageId(pageId);
    if (!key) return null;

    const entry = this.state.entries[key];
    if (!entry) return null;

    if (!isFresh(entry, this.state.ttlMs)) {
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
  getIfUpToDate(pageId: string, minLastEditedTimeISO: string | null): NotionLivePage | null {
    const entry = this.get(pageId);
    if (!entry) return null;

    if (!minLastEditedTimeISO) return entry;
    if (!entry.lastEditedTime) return null;

    const min = Date.parse(minLastEditedTimeISO);
    const got = Date.parse(entry.lastEditedTime);

    // Se não der pra parsear, não bloqueia (fallback permissivo)
    if (!Number.isFinite(min) || !Number.isFinite(got)) return entry;

    return got >= min ? entry : null;
  }

  /** Salva/atualiza uma página (sempre renova fetchedAt). */
  set(page: Omit<NotionLivePage, "fetchedAt">): NotionLivePage {
    const pageId = normalizePageId(page.pageId);
    if (!pageId) {
      throw new Error("PageIdNotionCache.set: pageId vazio");
    }

    const entry: NotionLivePage = {
      ...page,
      pageId,
      fetchedAt: now(),
    };

    this.state.entries[pageId] = entry;
    return entry;
  }

  /** Para debug/telemetria: quantas entradas ainda estão válidas */
  size(): number {
    this.pruneExpired();
    return Object.keys(this.state.entries).length;
  }
}
