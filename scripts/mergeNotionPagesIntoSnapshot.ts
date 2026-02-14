import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

type AnalyzerNotionPage = {
  notion_id?: string;
  url?: string | null;
  title?: string | null;
  filename?: string | null;
  creator?: string | null;
  created_time?: string | null;
  last_edited_time?: string | null;
  [k: string]: unknown;
};

function normalizeAnalyzerPages(raw: any): AnalyzerNotionPage[] {
  if (!raw) return [];

  const pagesRaw = raw.pages ?? raw.Pages ?? raw.notion_pages ?? null;

  // formato: { pages: [ ... ] }
  if (Array.isArray(pagesRaw)) return pagesRaw as AnalyzerNotionPage[];

  // formato: { pages: { "<id>": {..}, ... } }
  if (pagesRaw && typeof pagesRaw === "object") {
    return Object.values(pagesRaw) as AnalyzerNotionPage[];
  }

  return [];
}

type NotionPage = {
  notion_id: string;
  url: string | null; // ✅ URL DO MOD (propriedade URL da database)
  title: string | null;
  filename: string | null;
  creator: string | null;
  created_time?: string | null;
  last_edited_time?: string | null;
};

type AnalyzerNotionExport = {
  pages: Record<string, NotionPage>;
};

type Snapshot = {
  meta: any;

  /**
   * ✅ CANONICAL: espelho do Notion para matching determinístico (Phase 2).
   * A URL aqui deve ser a URL do MOD (propriedade URL), não o link interno do Notion.
   */
  notion_pages?: Record<string, NotionPage>;

  /**
   * ⚠️ LEGACY compat: ainda espelhamos para não quebrar consumidores antigos.
   */
  phase_2_cache?: {
    pages?: Record<string, NotionPage>;
    [k: string]: unknown;
  };

  phase_3_cache: any;
  canonical_log: any[];
};

function loadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function saveJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ===== PATCH: URL do MOD é fonte de verdade (vinda do export) =====

function normalizeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return t;
}

function mergePagesIntoSnapshot(
  snapshot: Snapshot,
  exportData: AnalyzerNotionExport,
  mode: "skip" | "update" = "skip"
): Snapshot {
  // ✅ CANONICAL target
  if (!snapshot.notion_pages) snapshot.notion_pages = {};

  // ⚠️ LEGACY target (compat)
  if (!snapshot.phase_2_cache) snapshot.phase_2_cache = {};
  if (!snapshot.phase_2_cache.pages) snapshot.phase_2_cache.pages = {};

  const targetCanonical = snapshot.notion_pages;
  const targetLegacy = snapshot.phase_2_cache.pages;
  const source = exportData.pages || {};

  let added = 0;
  let updated = 0; // update total (mode=update)
  let patchedUrl = 0; // ✅ PATCH: URL do MOD corrigida mesmo em mode=skip

  for (const [pageId, page] of Object.entries(source)) {
    const existsCanonical = Boolean(targetCanonical[pageId]);
    const existsLegacy = Boolean(targetLegacy[pageId]);

    if (!existsCanonical) {
      targetCanonical[pageId] = page;
      if (!existsLegacy) targetLegacy[pageId] = page;
      added++;
      continue;
    }

    if (mode === "update") {
      // overwrite completo (comportamento original)
      targetCanonical[pageId] = page;
      targetLegacy[pageId] = page;
      updated++;
      continue;
    }

    // mode === "skip":
    // ✅ Patch cirúrgico: se o export traz URL do MOD válida, ela é a fonte de verdade.
    // Não importa se o snapshot tinha notion.so ou qualquer outra coisa.
    const existing = targetCanonical[pageId];
    const incomingUrl = normalizeUrl(page.url);

    if (incomingUrl) {
      const existingUrl = normalizeUrl(existing.url); // pode ser null
      if (existingUrl !== incomingUrl) {
        existing.url = incomingUrl;
        patchedUrl++;
      }
    }

    // garante legacy espelhado
    if (!existsLegacy) {
      targetLegacy[pageId] = existing;
    } else {
      // se mexeu no canonical, mantém legacy em sync também
      if (incomingUrl && normalizeUrl(targetLegacy[pageId]?.url) !== incomingUrl) {
        targetLegacy[pageId] = existing;
      }
    }
  }

  console.log(
    `Merged Notion pages into snapshot: added=${added}, updated=${updated}, patched_url=${patchedUrl}`
  );

  return snapshot;
}

function main() {
  const snapshotPath =
    process.argv[2] || path.resolve(process.cwd(), "snapshot.json");
  const exportPath =
    process.argv[3] || path.resolve(process.cwd(), "analyzer_notionsync.json");

  const snapshot: Snapshot =
    loadJson<Snapshot>(snapshotPath) ?? {
      meta: {},
      notion_pages: {},
      phase_2_cache: { pages: {} },
      phase_3_cache: {},
      canonical_log: []
    };

  const exportRaw = loadJson<any>(exportPath);
  const pagesArr = normalizeAnalyzerPages(exportRaw);

  if (pagesArr.length === 0) {
    console.error("No analyzer_notionsync.json or missing pages.");
    process.exit(1);
  }

  // Reconstrói no formato: Record<id, page>
  const exportData: AnalyzerNotionExport = {
    pages: Object.fromEntries(
      pagesArr
        .filter((p) => typeof p.notion_id === "string" && p.notion_id.length > 0)
        .map((p) => {
          const id = p.notion_id as string;
          const page: NotionPage = {
            notion_id: id,
            url: (typeof p.url === "string" ? p.url : null) ?? null,
            title: (typeof p.title === "string" ? p.title : null) ?? null,
            filename: (typeof p.filename === "string" ? p.filename : null) ?? null,
            creator: (typeof p.creator === "string" ? p.creator : null) ?? null,
            created_time:
              (typeof p.created_time === "string" ? p.created_time : null) ?? null,
            last_edited_time:
              (typeof p.last_edited_time === "string" ? p.last_edited_time : null) ??
              null
          };
          return [id, page];
        })
    )
  };

  const merged = mergePagesIntoSnapshot(snapshot, exportData, "skip");
  saveJson(snapshotPath, merged);
}

const __filename = fileURLToPath(import.meta.url);

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isEntryPoint()) {
  main();
}
