import type { Identity } from "./domain/identity.js";
import type { Decision } from "./domain/decision.js";
import type { Snapshot } from "./domain/snapshot.js";

const inputUrl = process.argv[2];

if (!inputUrl) {
  console.error("Erro: informe uma URL");
  console.error("Uso: node dist/main.js <url>");
  process.exit(1);
}

const identity: Identity = {
  url: inputUrl,
  domain: "patreon.com",
  urlSlug: "example",
  pageTitle: null,
  ogTitle: null,
  ogSite: null,
  isBlocked: false,
};

const decision: Decision = {
  result: "NOT_FOUND",
  phaseResolved: "PHASE_3",
  reason: "AI fallback no match",
};

const snapshot: Snapshot = {
  identity,
  decision,
  createdAt: new Date(),
};

console.log("Snapshot gerado:");
console.log(snapshot);
