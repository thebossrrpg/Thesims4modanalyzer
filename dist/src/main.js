// src/main.ts — v1.2.0 (Phase 3 wired end-to-end)
//
// Phase 0/0.5: determinístico no snapshot
// Phase 1: analyzeUrl -> Identity (hard 404 => REJECTED_404)
// Phase 2: fuzzy no snapshot (phase_2_cache)
// Phase 2.5: planeja Phase 3 (topK + modo)
// Phase 3: evidence cache -> Notion live (pageId cache) -> AI (bart-mnli) -> decisão final
//
// Regras-chave:
// - URL cache: só determinístico (PHASE_0, PHASE_0_5, REJECTED_404)
// - Evidence cache: só quando houver evidenceKey (tipicamente quando Phase 3 roda)
// - Notion live: opcional; se faltar NOTION_API_KEY, segue offline
// - IA: threshold 0.55 (55%) conforme contrato atual
import "dotenv/config";
import fs from "fs";
import { analyzeUrl } from "./phase1/analyzeUrl.js";
import { searchNotionCache } from "./phase2/searchNotionCache.js";
import { phase25Rescue } from "./phase2/phase25Rescue.js";
import { aiDisambiguate, isIdentityValidForAI } from "./phase3/aiDisambiguate.js";
import { getNotionPageUrl } from "./utils/notion.js";
import { buildSnapshotVersion } from "./utils/snapshotVersion.js";
import { initCaches, buildEvidenceKey, persistDecision, hydrateFoundFromCandidates, } from "./utils/cache.js";
import { buildPhase25Debug, buildPhase3Debug, mapUnfurlViaToProvider, candidatesToDebugTop5, createBaseDebug, setRejected404, } from "./utils/debug.js";
import { NotionClient } from "./notion/notionClient.js";
// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────
const POLICY_VERSION = "phase3-ai-v1";
const AI_THRESHOLD = 0.55;
// ─────────────────────────────────────────────────────────────
// ARGS
// ─────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find((a) => !a.startsWith("--"));
const flagJson = rawArgs.includes("--json");
const startedAt = new Date().toISOString();
// ─────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────
function emit(out) {
    if (flagJson) {
        console.log(JSON.stringify(out, null, 2));
    }
    else {
        printHumanSummary(out);
    }
}
function printHumanSummary(out) {
    console.log(`\n🔗 ${out.inputUrl}`);
    console.log(`📌 Resultado: ${out.status}`);
    if (out.reason)
        console.log(`🧠 Motivo: ${out.reason}`);
    if (out.status === "FOUND" && out.found) {
        console.log(`✅ Match: ${out.found.title ?? out.found.pageId}`);
        if (out.found.pageUrl)
            console.log(`🗂️  Notion: ${out.found.pageUrl}`);
    }
    if (out.status === "AMBIGUOUS" && out.ambiguous) {
        const candidateNames = out.debug?.phase2?.candidatesTop5?.map(c => c.title || c.pageId?.slice(0, 8) || '?') || out.ambiguous.pageIds.slice(0, 3).map(id => id.slice(0, 8));
        console.log(`⚠️ Candidatos: ${candidateNames.join(", ")}`);
    }
    if (out.status === "REJECTED_404") {
        const r = out.debug.validation.rejected404Reason ?? "(sem motivo)";
        console.log(`⛔ URL rejeitada: ${r}`);
    }
    console.log("");
}
// ─────────────────────────────────────────────────────────────
// HELPERS — snapshot / Phase 0 / 0.5
// ─────────────────────────────────────────────────────────────
function loadSnapshot(snapshotPath) {
    const raw = fs.readFileSync(snapshotPath, "utf-8");
    return JSON.parse(raw);
}
function urlLookupKeys(rawUrl) {
    if (!rawUrl)
        return [];
    const canonical = rawUrl.trim();
    const noScheme = canonical.replace(/^https?:\/\//i, "");
    const compact = noScheme.replace(/[./]/g, "");
    return [canonical, noScheme, compact];
}
function extractFinalSlug(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const domain = url.hostname.replace(/^www\./i, "").toLowerCase();
        const parts = url.pathname
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .filter(Boolean);
        if (!parts.length)
            return null;
        const slug = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9\-]/g, "");
        if (!slug)
            return null;
        return { slug, domain };
    }
    catch {
        return null;
    }
}
// ─────────────────────────────────────────────────────────────
// HELPERS — Phase 3 (Notion live enrichment)
// ─────────────────────────────────────────────────────────────
async function enrichCandidatesWithNotionLive(caches, candidates) {
    let fetchedPages = 0;
    let cacheHitPages = 0;
    // "online" aqui significa: usamos dados live (do cache ou da API)
    let usedAnyLive = false;
    // NotionClient falha explicitamente se não houver NOTION_API_KEY.
    // A Phase 3 continua mesmo sem Notion (offline-first).
    let notion = null;
    try {
        notion = new NotionClient();
    }
    catch {
        notion = null;
    }
    const enriched = [];
    let notionCacheDirty = false;
    for (const c of candidates) {
        const pageId = String(c.notion_id);
        // 1) tenta cache "live" respeitando last_edited_time do snapshot
        const cachedLive = caches.notionLive.getIfUpToDate(pageId, c.last_edited_time ?? null);
        if (cachedLive) {
            cacheHitPages += 1;
            usedAnyLive = true;
            enriched.push({
                ...c,
                title: c.title ?? cachedLive.title ?? null,
                // só preenche creator se estiver vazio (evita sobrescrever "creator" de domínio)
                creator: c.creator ?? cachedLive.creator ?? null,
                // NÃO sobrescreve c.url (isso é URL do mod, não URL da página Notion)
                last_edited_time: c.last_edited_time ?? cachedLive.lastEditedTime ?? c.last_edited_time,
            });
            continue;
        }
        // 2) sem cache: tenta API (se disponível)
        if (!notion) {
            enriched.push(c);
            continue;
        }
        try {
            const live = await notion.getPage(pageId);
            // grava no cache live (PageIdNotionCache gerencia TTL + fetchedAt)
            caches.notionLive.set(live);
            notionCacheDirty = true;
            fetchedPages += 1;
            usedAnyLive = true;
            enriched.push({
                ...c,
                title: c.title ?? live.title ?? null,
                creator: c.creator ?? live.creator ?? null,
                last_edited_time: c.last_edited_time ?? live.lastEditedTime ?? c.last_edited_time,
            });
        }
        catch {
            // Falha de Notion não deve derrubar a execução: segue offline.
            enriched.push(c);
        }
    }
    if (notionCacheDirty) {
        caches.notionLive.save();
    }
    return {
        enriched,
        mode: usedAnyLive ? "online" : "offline",
        fetchedPages,
        cacheHitPages,
    };
}
// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
    // ── VALIDAÇÃO / REJECTED_404 ─────────────────────────────
    const debug = createBaseDebug(inputUrl);
    if (!inputUrl || inputUrl.trim().length < 10) {
        setRejected404(debug, "url_not_http");
        const out = {
            startedAt,
            inputUrl: inputUrl ?? "",
            status: "REJECTED_404",
            phaseResolved: "REJECTED_404",
            reason: "URL não é http(s)",
            debug,
        };
        emit(out);
        process.exit(0);
    }
    try {
        // ── SNAPSHOT + CACHE INIT ────────────────────────────────
        const snapshot = loadSnapshot("./snapshot.json");
        const snapshotVersion = buildSnapshotVersion(snapshot);
        const caches = initCaches({
            snapshotVersion,
            policyVersion: POLICY_VERSION,
        });
        // ⚡ URL CACHE SHORT-CIRCUIT (determinístico)
        const urlCacheHit = caches.engine.getUrlDecision(inputUrl);
        if (urlCacheHit) {
            console.log("⚡ URL cache hit");
            // Hidratação determinística: procura no snapshot "real" (Phase 0/0.5)
            let found = undefined;
            if (urlCacheHit.chosenNotionId) {
                const id = String(urlCacheHit.chosenNotionId);
                // 1) tenta pelo snapshot (fonte de verdade do Phase 0/0.5)
                const snapPage = snapshot.notion_pages?.[id];
                if (snapPage) {
                    const title = String(snapPage.title ?? snapPage.filename ?? snapPage.url ?? snapPage.notion_id);
                    found = {
                        pageId: id,
                        pageUrl: getNotionPageUrl(id, title),
                        title,
                    };
                }
                else {
                    // 2) fallback: tenta phase_2_cache (caso tenha gravado chosenNotionId vindo de Phase 2/3)
                    const p2Page = snapshot.phase_2_cache?.pages?.[id];
                    const title = String(p2Page?.title ?? p2Page?.filename ?? p2Page?.url ?? id);
                    found = {
                        pageId: id,
                        pageUrl: getNotionPageUrl(id, title),
                        title,
                    };
                }
            }
            const cachedOut = {
                startedAt,
                inputUrl,
                status: urlCacheHit.result,
                phaseResolved: urlCacheHit.phaseResolved,
                reason: String(urlCacheHit.reason ?? ""),
                debug,
                meta: {
                    decisionCache: { hit: true, key: String(urlCacheHit.urlKey ?? inputUrl) },
                },
                ...(found ? { found } : {}),
            };
            emit(cachedOut);
            process.exit(0);
        }
        // ✅ IMPORTANTÍSSIMO: não misturar datasets.
        // - Phase 0/0.5 usam snapshot.notion_pages (fonte).
        // - Phase 2 usa snapshot.phase_2_cache.pages (índice fuzzy).
        const notionPagesPhase0 = snapshot.notion_pages ?? {};
        const notionPagesPhase2 = snapshot.phase_2_cache?.pages ?? {};
        // ── PHASE 0 — URL lookup exato ───────────────────────────
        const inputKeys = urlLookupKeys(inputUrl);
        const phase0Match = Object.values(notionPagesPhase0).find((p) => {
            if (!p.url)
                return false;
            const pKeys = urlLookupKeys(p.url);
            return pKeys.some((k) => inputKeys.includes(k));
        });
        debug.phase0 = {
            exactMatch: Boolean(phase0Match),
            matchedPageId: phase0Match?.notion_id,
        };
        if (phase0Match) {
            const title = String(phase0Match.title ?? phase0Match.filename ?? phase0Match.url ?? phase0Match.notion_id);
            const out = {
                startedAt,
                inputUrl,
                status: "FOUND",
                phaseResolved: "PHASE_0",
                reason: "Direct URL match in Notion snapshot (Phase 0)",
                debug,
                found: {
                    pageId: String(phase0Match.notion_id),
                    pageUrl: getNotionPageUrl(String(phase0Match.notion_id), title),
                    title,
                },
            };
            persistDecision(caches, { inputUrl, out });
            emit(out);
            process.exit(0);
        }
        // ── PHASE 0.5 — Slug match ───────────────────────────────
        const inputSlugData = extractFinalSlug(inputUrl);
        let phase05Match = null;
        if (inputSlugData) {
            const slugMatches = Object.values(notionPagesPhase0).filter((p) => {
                if (!p.url)
                    return false;
                const snapSlug = extractFinalSlug(p.url);
                if (!snapSlug)
                    return false;
                return snapSlug.slug === inputSlugData.slug;
            });
            if (slugMatches.length === 1) {
                phase05Match = slugMatches[0];
            }
        }
        debug.phase05 = {
            slugMatch: Boolean(phase05Match),
            matchedPageId: phase05Match?.notion_id,
        };
        if (phase05Match) {
            const snapSlugData = extractFinalSlug(phase05Match.url);
            const title = String(phase05Match.title ?? phase05Match.filename ?? phase05Match.url ?? phase05Match.notion_id);
            const out = {
                startedAt,
                inputUrl,
                status: "FOUND",
                phaseResolved: "PHASE_0_5",
                reason: snapSlugData?.domain === inputSlugData?.domain
                    ? "Slug match (same domain)"
                    : "Slug match (cross-domain)",
                debug,
                found: {
                    pageId: String(phase05Match.notion_id),
                    pageUrl: getNotionPageUrl(String(phase05Match.notion_id), title),
                    title,
                },
            };
            persistDecision(caches, { inputUrl, out });
            emit(out);
            process.exit(0);
        }
        // ── PHASE 1 — analyzeUrl → Identity ─────────────────────
        // Hard 404 capturado aqui → REJECTED_404 estruturado
        let identity;
        try {
            identity = await analyzeUrl(inputUrl);
        }
        catch (phase1Err) {
            const msg = String(phase1Err?.message ?? "");
            const is404 = msg.toLowerCase().includes("404") ||
                msg.toLowerCase().includes("não retornou") ||
                msg.toLowerCase().includes("page not found") ||
                msg.toLowerCase().includes("not found");
            if (!is404) {
                // erro inesperado → propaga (exit 1)
                throw phase1Err;
            }
            setRejected404(debug, msg);
            const out = {
                startedAt,
                inputUrl,
                status: "REJECTED_404",
                phaseResolved: "REJECTED_404",
                reason: "Página inválida ou URL não retornou conteúdo válido (hard 404).",
                debug,
            };
            persistDecision(caches, { inputUrl, out });
            emit(out);
            process.exit(0);
        }
        debug.phase1 = {
            blocked: Boolean(identity.isBlocked),
            providersUsed: [mapUnfurlViaToProvider(identity.unfurlVia)],
            identity,
        };
        // ── PHASE 2 — fuzzy no snapshot ──────────────────────────
        const phase2Result = await searchNotionCache(identity, notionPagesPhase2);
        const phase2Candidates = phase2Result.candidates ?? [];
        debug.phase2 = {
            candidatesCount: phase2Candidates.length,
            candidatesTop5: candidatesToDebugTop5(phase2Candidates),
        };
        // Short-circuit: Phase 2 resolveu com confiança
        if (phase2Result.decision.result === "FOUND") {
            const pageId = String(phase2Result.decision.notionId ?? "");
            const title = String(phase2Result.decision.displayName ?? pageId);
            const out = {
                startedAt,
                inputUrl,
                status: "FOUND",
                phaseResolved: "PHASE_2",
                reason: phase2Result.decision.reason ?? "",
                debug,
                found: {
                    pageId,
                    pageUrl: getNotionPageUrl(pageId, title || pageId),
                    title,
                },
            };
            // Phase 2 não gera URL cache (não-determinístico).
            // Sem evidenceKey aqui por padrão (Phase 3 é o alvo do evidence cache).
            emit(out);
            process.exit(0);
        }
        // ── PHASE 2.5 — rescue (fonte única de verdade) ──────────
        const rescue = phase25Rescue(phase2Candidates);
        const phase3Candidates = rescue.plan.phase3Candidates;
        debug.phase25 = buildPhase25Debug(phase3Candidates, rescue.selectionRule);
        // Short-circuit: Phase 2.5 decidiu não chamar Phase 3
        if (!rescue.plan.shouldCallPhase3) {
            const d = phase2Result.decision;
            const out = {
                startedAt,
                inputUrl,
                status: d.result,
                phaseResolved: d.phaseResolved,
                reason: d.reason ?? "",
                debug,
                ...(d.notionId
                    ? {
                        found: hydrateFoundFromCandidates(String(d.notionId), phase3Candidates, getNotionPageUrl),
                    }
                    : {}),
                ...(d.result === "AMBIGUOUS"
                    ? { ambiguous: { pageIds: phase2Candidates.map((c) => String(c.notion_id)) } }
                    : {}),
            };
            emit(out);
            process.exit(0);
        }
        // ── EVIDENCE KEY + EVIDENCE CACHE SHORT-CIRCUIT ──────────
        const evidenceKey = buildEvidenceKey(caches, {
            identity,
            candidates: phase3Candidates,
            policyVersion: POLICY_VERSION,
        });
        // 1) AiDecisionCache (mais específico)
        const aiCacheHit = caches.ai.get(evidenceKey);
        if (aiCacheHit) {
            console.log("⚡ AI evidence cache hit");
            const cachedStatus = aiCacheHit.result;
            // debug.phase3 precisa existir (chegou na Phase 3 via cache)
            debug.phase3 = buildPhase3Debug({
                mode: "offline",
                finalCandidates: cachedStatus === "FOUND" ? 1 : phase3Candidates.length,
                finalCandidatePageIds: cachedStatus === "FOUND" && aiCacheHit.chosenNotionId
                    ? [String(aiCacheHit.chosenNotionId)]
                    : cachedStatus === "AMBIGUOUS"
                        ? phase3Candidates.map((c) => String(c.notion_id))
                        : undefined,
            });
            debug.phase3.cacheUsed = true;
            const cachedOut = {
                startedAt,
                inputUrl,
                status: cachedStatus,
                phaseResolved: aiCacheHit.phaseResolved,
                reason: aiCacheHit.reason,
                debug,
                meta: {
                    aiDecisionCache: { hit: true, key: evidenceKey },
                },
                ...(aiCacheHit.chosenNotionId
                    ? {
                        found: hydrateFoundFromCandidates(String(aiCacheHit.chosenNotionId), phase3Candidates, getNotionPageUrl),
                    }
                    : {}),
                ...(cachedStatus === "AMBIGUOUS"
                    ? { ambiguous: { pageIds: phase3Candidates.map((c) => String(c.notion_id)) } }
                    : {}),
            };
            emit(cachedOut);
            process.exit(0);
        }
        // 2) CacheEngine decision cache (fallback)
        const decisionCacheHit = caches.engine.getDecision(evidenceKey);
        if (decisionCacheHit) {
            console.log("⚡ Evidence cache hit");
            const cachedStatus = decisionCacheHit.result;
            debug.phase3 = buildPhase3Debug({
                mode: "offline",
                finalCandidates: cachedStatus === "FOUND" ? 1 : phase3Candidates.length,
                finalCandidatePageIds: cachedStatus === "FOUND" && decisionCacheHit.chosenNotionId
                    ? [String(decisionCacheHit.chosenNotionId)]
                    : cachedStatus === "AMBIGUOUS"
                        ? phase3Candidates.map((c) => String(c.notion_id))
                        : undefined,
            });
            debug.phase3.cacheUsed = true;
            const cachedOut = {
                startedAt,
                inputUrl,
                status: cachedStatus,
                phaseResolved: decisionCacheHit.phaseResolved,
                reason: String(decisionCacheHit.reason ?? ""),
                debug,
                meta: {
                    decisionCache: { hit: true, key: evidenceKey },
                },
                ...(decisionCacheHit.chosenNotionId
                    ? {
                        found: hydrateFoundFromCandidates(String(decisionCacheHit.chosenNotionId), phase3Candidates, getNotionPageUrl),
                    }
                    : {}),
                ...(cachedStatus === "AMBIGUOUS"
                    ? { ambiguous: { pageIds: phase3Candidates.map((c) => String(c.notion_id)) } }
                    : {}),
            };
            emit(cachedOut);
            process.exit(0);
        }
        // ── PHASE 3 — Notion live + IA ───────────────────────────
        const hasValidIdentity = isIdentityValidForAI(identity);
        if (!hasValidIdentity) {
            // Identidade ruim => IA não roda (contrato).
            // Retorna decisão de Phase 2 (AMBIGUOUS ou NOTFOUND) com contexto em debug.
            const d = phase2Result.decision;
            const out = {
                startedAt,
                inputUrl,
                status: d.result,
                phaseResolved: d.phaseResolved,
                reason: d.reason ?? "",
                debug,
                ...(d.result === "AMBIGUOUS"
                    ? { ambiguous: { pageIds: phase2Candidates.map((c) => String(c.notion_id)) } }
                    : {}),
            };
            emit(out);
            process.exit(0);
        }
        console.log("\n🤖 [Phase 3] Gates passed. Enriching candidates via Notion live (if available)...");
        const notionLive = await enrichCandidatesWithNotionLive(caches, phase3Candidates);
        // Agora roda IA em cima dos candidatos enriquecidos
        // Agora roda IA em cima dos candidatos enriquecidos
        console.log("🤖 [Phase 3] Running AI disambiguation...");
        let aiResult = null;
        try {
            const aiIdentity = {
                ...identity,
                pageTitle: identity.urlSlug || identity.pageTitle,
                ogTitle: identity.ogTitle || identity.pageTitle || identity.urlSlug || "",
            };
            aiResult = await aiDisambiguate(aiIdentity, notionLive.enriched);
        }
        catch (e) {
            // fallback Phase 2 (igual seu código)
            const d = phase2Result.decision;
            const errMsg = String(e?.message ?? e ?? "erro_na_ia");
            debug.phase3 = buildPhase3Debug({
                mode: notionLive.mode,
                finalCandidates: rescue.plan.mode === "DISAMBIGUATE" ? notionLive.enriched.length : 0,
                finalCandidatePageIds: rescue.plan.mode === "DISAMBIGUATE"
                    ? notionLive.enriched.map((c) => String(c.notionid || c.notion_id))
                    : undefined,
            });
            debug.phase3.notionApi = { fetchedPages: notionLive.fetchedPages };
            const out = {
                startedAt,
                inputUrl,
                status: d.result,
                phaseResolved: d.phaseResolved,
                reason: `${d.reason ?? ""} | Phase 3 indisponível: ${errMsg}`,
                debug,
                ...(d.result === "AMBIGUOUS"
                    ? { ambiguous: { pageIds: phase2Candidates.map((c) => String(c.notionid || c.notion_id)) } }
                    : {}),
            };
            emit(out);
            process.exit(0);
        }
        const aiMatched = aiResult.matchedIndex >= 0 && aiResult.confidence >= AI_THRESHOLD;
        // monta debug.phase3
        if (aiMatched) {
            const chosen = notionLive.enriched[aiResult.matchedIndex];
            debug.phase3 = buildPhase3Debug({
                mode: notionLive.mode,
                finalCandidates: 1,
                finalCandidatePageIds: [String(chosen.notion_id)],
            });
        }
        else {
            debug.phase3 = buildPhase3Debug({
                mode: notionLive.mode,
                finalCandidates: rescue.plan.mode === "DISAMBIGUATE" ? notionLive.enriched.length : 0,
                finalCandidatePageIds: rescue.plan.mode === "DISAMBIGUATE"
                    ? notionLive.enriched.map((c) => String(c.notion_id))
                    : undefined,
            });
        }
        debug.phase3.notionApi = { fetchedPages: notionLive.fetchedPages };
        if (aiMatched) {
            const matched = notionLive.enriched[aiResult.matchedIndex];
            const title = String(matched.title ?? matched.filename ?? matched.url ?? matched.notion_id);
            const reason = `AI match: ${aiResult.reason} (${(aiResult.confidence * 100).toFixed(0)}%)`;
            const out = {
                startedAt,
                inputUrl,
                status: "FOUND",
                phaseResolved: "PHASE_3",
                reason,
                debug,
                found: {
                    pageId: String(matched.notion_id),
                    pageUrl: getNotionPageUrl(String(matched.notion_id), title),
                    title,
                },
            };
            // Aqui sim: grava evidence cache + aiDecisionCache
            persistDecision(caches, {
                inputUrl,
                out,
                evidenceKey,
                candidates: notionLive.enriched,
                aiConfidence: aiResult.confidence,
            });
            emit(out);
            process.exit(0);
        }
        // IA não bateu threshold.
        // - DISAMBIGUATE => AMBIGUOUS (Phase 3)
        // - CONFIRM_SINGLE_WEAK => NOTFOUND (Phase 3)
        if (rescue.plan.mode === "DISAMBIGUATE") {
            const out = {
                startedAt,
                inputUrl,
                status: "AMBIGUOUS",
                phaseResolved: "PHASE_3",
                reason: `AI inconclusiva: ${aiResult.reason} (${(aiResult.confidence * 100).toFixed(0)}%)`,
                debug,
                ambiguous: {
                    pageIds: notionLive.enriched.map((c) => String(c.notion_id)),
                },
            };
            persistDecision(caches, {
                inputUrl,
                out,
                evidenceKey,
                candidates: notionLive.enriched,
                aiConfidence: aiResult.confidence,
            });
            emit(out);
            process.exit(0);
        }
        // CONFIRM_SINGLE_WEAK
        const out = {
            startedAt,
            inputUrl,
            status: "NOTFOUND",
            phaseResolved: "PHASE_3",
            reason: `AI não confirmou candidato fraco: ${aiResult.reason} (${(aiResult.confidence * 100).toFixed(0)}%)`,
            debug,
        };
        persistDecision(caches, {
            inputUrl,
            out,
            evidenceKey,
            candidates: notionLive.enriched,
            aiConfidence: aiResult.confidence,
        });
        emit(out);
        process.exit(0);
    }
    catch (err) {
        console.error("\n❌ Erro fatal:");
        console.error(err);
        process.exit(1);
    }
})();
