import fs from "node:fs";
import path from "node:path";

const snapshotPath = path.resolve(process.cwd(), "snapshot.json");
const exportPath = path.resolve(process.cwd(), "analyzer_notionsync.json");

const targetId = "2e53ae64-a3a5-8099-b928-ff0ef167d3e2"; // Sim Control Hub

console.log("=== DEBUG MERGE ===\n");

// 1. Ler snapshot
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const snapshotEntry = 
  snapshot.notion_pages?.[targetId] ?? 
  snapshot.phase_2_cache?.pages?.[targetId] ?? 
  null;

console.log("1. SNAPSHOT (atual):");
console.log(JSON.stringify(snapshotEntry, null, 2));
console.log();

// 2. Ler analyzer_notionsync
const exportRaw = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const pagesArr = exportRaw.pages ?? exportRaw.Pages ?? exportRaw.notion_pages ?? null;

let exportEntry = null;
if (Array.isArray(pagesArr)) {
  exportEntry = pagesArr.find((p: any) => p.notion_id === targetId);
} else if (pagesArr && typeof pagesArr === "object") {
  exportEntry = pagesArr[targetId] ?? Object.values(pagesArr).find((p: any) => (p as any).notion_id === targetId);
}

console.log("2. ANALYZER_NOTIONSYNC (source):");
console.log(JSON.stringify(exportEntry, null, 2));
console.log();

// 3. Mostrar estrutura raiz do analyzer_notionsync
console.log("3. ESTRUTURA RAIZ do analyzer_notionsync.json:");
console.log(Object.keys(exportRaw));
console.log();

// 4. Verificar formato das URLs
console.log("4. FORMATO DAS URLs:");
console.log(`  Snapshot URL: "${snapshotEntry?.url}"`);
console.log(`  Export URL:   "${exportEntry?.url}"`);
console.log();

console.log("=== FIM DEBUG ===");
