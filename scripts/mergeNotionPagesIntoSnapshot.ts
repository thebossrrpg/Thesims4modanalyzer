import fs from "node:fs";
import path from "node:path";

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

  const exportData = loadJson<AnalyzerNotionExport>(exportPath);

  if (!exportData || !exportData.pages) {
    console.error("No analyzer_notionsync.json or missing pages.");
    process.exit(1);
  }

  const merged = mergePagesIntoSnapshot(snapshot, exportData, "skip");
  saveJson(snapshotPath, merged);
}

if (require.main === module) {
  main();
}
