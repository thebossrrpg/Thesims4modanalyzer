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

  // formato atual: { pages: { "<id>": {..}, ... } }
  if (pagesRaw && typeof pagesRaw === "object") {
    return Object.values(pagesRaw) as AnalyzerNotionPage[];
  }

  return [];
}

type NotionPage = {
  notion_id: string;
  url: string | null;
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
  phase_2_cache: {
    pages: Record<string, NotionPage>;
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

function mergePagesIntoSnapshot(
  snapshot: Snapshot,
  exportData: AnalyzerNotionExport,
  mode: "skip" | "update" = "skip"
): Snapshot {
  if (!snapshot.phase_2_cache) {
    snapshot.phase_2_cache = { pages: {} };
  }
  if (!snapshot.phase_2_cache.pages) {
    snapshot.phase_2_cache.pages = {};
  }

  const target = snapshot.phase_2_cache.pages;
  const source = exportData.pages || {};

  let added = 0;
  let updated = 0;

  for (const [pageId, page] of Object.entries(source)) {
    if (!target[pageId]) {
      target[pageId] = page;
      added++;
    } else if (mode === "update") {
      target[pageId] = page;
      updated++;
    }
  }

  console.log(
    `Merged Notion pages into snapshot: added=${added}, updated=${updated}`
  );

  return snapshot;
}

function main() {
  const snapshotPath =
    process.argv[2] || path.resolve(process.cwd(), "snapshot.json");
  const exportPath =
    process.argv[3] ||
    path.resolve(process.cwd(), "analyzer_notionsync.json");

  const snapshot: Snapshot =
    loadJson<Snapshot>(snapshotPath) ?? {
      meta: {},
      phase_2_cache: { pages: {} },
      phase_3_cache: {},
      canonical_log: []
    };

  // ✅ Lê o export como "raw" e normaliza o schema (map ou array)
  const exportRaw = loadJson<any>(exportPath);
  const pagesArr = normalizeAnalyzerPages(exportRaw);

  if (pagesArr.length === 0) {
    console.error("No analyzer_notionsync.json or missing pages.");
    process.exit(1);
  }

  // ✅ Reconstrói no formato canônico que o merge já espera: Record<id, page>
  const exportData: AnalyzerNotionExport = {
    pages: Object.fromEntries(
      pagesArr
        .filter((p) => typeof p.notion_id === "string" && p.notion_id.length > 0)
        .map((p) => [p.notion_id as string, p as NotionPage])
    )
  };

  const merged = mergePagesIntoSnapshot(snapshot, exportData, "skip");
  saveJson(snapshotPath, merged);
}

const __filename = fileURLToPath(import.meta.url);

function isEntryPoint(): boolean {
  const entry = process.argv[1]; // caminho do script passado ao node
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isEntryPoint()) {
  main();
}
