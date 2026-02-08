import { analyzeUrl } from "./phase1/analyzeUrl.js";

const inputUrl = process.argv[2];

if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
  console.error("❌ Erro: informe uma URL válida.");
  console.error("Uso: node dist/main.js <url>");
  process.exit(1);
}

const startedAt = new Date().toISOString();

try {
  const result = await analyzeUrl(inputUrl);

  const displayTitle =
    result.pageTitle ??
    result.ogTitle ??
    result.fallbackLabel ??
    `${result.domain} · ${result.urlSlug}`;

  const displaySource =
    result.pageTitle ? "pageTitle" :
    result.ogTitle ? "ogTitle" :
    result.fallbackLabel ? "fallbackLabel" :
    "domainSlug";

  const output = {
    createdAt: startedAt,
    phase: "PHASE_1",
    identity: result,
    displayTitle,
    displaySource
  };

  console.log("✅ Phase 1 — identidade extraída:");
  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  console.error("❌ Falha na Phase 1:");
  console.error(err);
  process.exit(1);
}
