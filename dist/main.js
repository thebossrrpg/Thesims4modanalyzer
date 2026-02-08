const inputUrl = process.argv[2];
if (!inputUrl) {
    console.error("Erro: informe uma URL");
    console.error("Uso: node dist/main.js <url>");
    process.exit(1);
}
const identity = {
    url: inputUrl,
    domain: "patreon.com",
    urlSlug: "example",
    pageTitle: null,
    ogTitle: null,
    ogSite: null,
    isBlocked: false,
};
const decision = {
    result: "NOT_FOUND",
    phaseResolved: "PHASE_3",
    reason: "AI fallback no match",
};
const snapshot = {
    identity,
    decision,
    createdAt: new Date().toISOString(),
};
console.log("Snapshot gerado:");
console.log(snapshot);
export {};
