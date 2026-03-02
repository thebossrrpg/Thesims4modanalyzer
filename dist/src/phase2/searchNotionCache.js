// src/phase2/searchNotionCache.ts (v3.3 - blocked structural mode + title weight zero)
//
// Decisões aplicadas:
// - Saídas do app: FOUND | AMBIGUOUS | NOTFOUND | REJECTED_404 (este arquivo cobre só Phase 2)
// - Creator do snapshot quase sempre null -> peso pequeno (0.05)
// - NOTFOUND retorna só TOP 5 melhores (não 10)
// - AMBIGUOUS também retorna TOP 5 (Phase 3 trabalha com 2..5)
// - Phase 2.5: planeja se chama Phase 3 (Notion live) para confirmar/desambiguar
//
// ✅ Novo:
// - Modo BLOCKED_STRUCTURAL quando identity.isBlocked = true
// - Título recebe peso ZERO em modo bloqueado (evita "Vercel Security Checkpoint" contaminar score)
// - Busca pode seguir com slug + domínio mesmo sem título
const THRESHOLD_FOUND = 0.48;
const THRESHOLD_CANDIDATE = 0.28;
const GAP_AMBIGUOUS = 0.15;
// Pesos base (somam ~0.85 + bônus domínio)
const W_TITLE = 0.60;
const W_CREATOR = 0.05;
const W_SLUG = 0.20;
const DOMAIN_BONUS = 0.05;
export async function searchNotionCache(identity, notionPages) {
    const candidates = [];
    const blockedStructuralMode = Boolean(identity.isBlocked);
    // Em modo bloqueado, NÃO confiamos em título/ogTitle.
    const rawTitle = blockedStructuralMode
        ? ""
        : (identity.pageTitle || identity.ogTitle || "");
    // Label só para logs/reason (não é necessariamente o texto usado no score de título)
    const searchLabel = blockedStructuralMode
        ? `[${identity.domain}] ${identity.urlSlug}`.trim()
        : (rawTitle || identity.urlSlug || "");
    const searchCreator = identity.creator || "";
    const searchDomain = identity.domain;
    const searchSlug = identity.urlSlug || "";
    // Guard: sem título E sem slug = impossível buscar
    if (!rawTitle && !searchSlug) {
        return {
            decision: {
                result: "NOTFOUND",
                phaseResolved: "PHASE_2",
                reason: "❌ No usable identity signals (title/slug) for Phase 2 search",
            },
            candidates: [],
        };
    }
    console.log("🔍 [Phase 2] Fuzzy search for:", {
        mode: blockedStructuralMode ? "BLOCKED_STRUCTURAL" : "NORMAL",
        title: rawTitle || "(ignored/empty)",
        creator: searchCreator || "(none)",
        domain: searchDomain,
        slug: searchSlug || "(none)",
        totalPages: Object.keys(notionPages).length,
    });
    const effectiveTitleWeight = blockedStructuralMode ? 0 : W_TITLE;
    const effectiveSlugWeight = blockedStructuralMode ? (W_SLUG + 0.15) : W_SLUG; // slug manda mais quando bloqueado
    const searchTitleNorm = normalizeTitle(rawTitle);
    const searchTokens = tokenize(rawTitle || searchSlug || "");
    for (const [, page] of Object.entries(notionPages)) {
        let score = 0;
        const reasons = [];
        const notionTitle = page.title || page.filename;
        const notionCreator = page.creator || "";
        if (!notionTitle)
            continue;
        const notionTitleNorm = normalizeTitle(notionTitle);
        // --- 1) TÍTULO (somente modo normal) ---
        if (effectiveTitleWeight > 0 && searchTitleNorm) {
            const titleSimilarity = calculateSimilarity(searchTitleNorm, notionTitleNorm);
            // Near-exact title match (somente se NÃO bloqueado)
            if (titleSimilarity >= 0.98) {
                console.log("✅ [Phase 2] Near-exact title match:", notionTitle);
                const immediateDecision = {
                    result: "FOUND",
                    phaseResolved: "PHASE_2",
                    reason: `🎯 Exact name match: "${rawTitle}" ≈ "${notionTitle}"`,
                    notionId: page.notion_id,
                    notionUrl: page.url,
                    displayName: notionTitle,
                    phase2Candidates: 1,
                };
                return {
                    decision: immediateDecision,
                    candidates: [page],
                };
            }
            // fallback token overlap quando Levenshtein é baixo
            if (titleSimilarity < 0.60) {
                const notionTokens = tokenize(notionTitle);
                const overlap = intersectionSize(searchTokens, notionTokens);
                const union = unionSize(searchTokens, notionTokens);
                if (union > 0) {
                    const tokenOverlapScore = overlap / union;
                    if (tokenOverlapScore >= 0.50) {
                        score += tokenOverlapScore * effectiveTitleWeight;
                        reasons.push(`tokens:${(tokenOverlapScore * 100).toFixed(0)}% (${overlap}/${union})`);
                    }
                    else {
                        score += titleSimilarity * effectiveTitleWeight;
                        if (titleSimilarity > 0.40)
                            reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
                    }
                }
                else {
                    score += titleSimilarity * effectiveTitleWeight;
                }
            }
            else {
                score += titleSimilarity * effectiveTitleWeight;
                if (titleSimilarity > 0.40)
                    reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
            }
        }
        // --- 2) CREATOR (peso pequeno 5%) ---
        if (searchCreator && notionCreator) {
            const creatorSimilarity = calculateSimilarity(normalizeTitle(searchCreator), normalizeTitle(notionCreator));
            score += creatorSimilarity * W_CREATOR;
            if (creatorSimilarity > 0.60) {
                reasons.push(`creator:${(creatorSimilarity * 100).toFixed(0)}%`);
            }
        }
        // --- 3) SLUG (peso estrutural; sobe em blocked mode) ---
        if (searchSlug && notionTitle) {
            const slugTokens = tokenize(searchSlug);
            const notionTokens = tokenize(notionTitle);
            const overlap = intersectionSize(slugTokens, notionTokens);
            const union = unionSize(slugTokens, notionTokens);
            if (union > 0) {
                const slugTokenScore = overlap / union;
                if (slugTokenScore > 0.20) { // em blocked mode, até overlap moderado já ajuda
                    score += slugTokenScore * effectiveSlugWeight;
                    reasons.push(`slugTokens:${(slugTokenScore * 100).toFixed(0)}%`);
                }
            }
        }
        // --- 4) DOMÍNIO (bônus fixo) ---
        if (searchDomain && page.url) {
            const pageDomain = extractDomain(page.url);
            if (looseDomainMatch(searchDomain, pageDomain)) {
                score += DOMAIN_BONUS;
                reasons.push("domain✓");
            }
        }
        if (score > THRESHOLD_CANDIDATE) {
            candidates.push({
                ...page,
                _score: score,
                _reasons: reasons,
            });
        }
    }
    // Ordenação
    candidates.sort((a, b) => b._score - a._score);
    const best = candidates[0];
    const bestScore = best?._score ?? 0;
    const secondBestScore = candidates[1]?._score ?? 0;
    const gap = bestScore - secondBestScore;
    console.log(`📊 [Phase 2] Found ${candidates.length} candidates, best score: ${(bestScore * 100).toFixed(0)}%`);
    const top5 = candidates.slice(0, 5);
    // 1) FOUND direto
    if (candidates.length > 0 && bestScore >= THRESHOLD_FOUND) {
        if (candidates.length > 1 && gap < GAP_AMBIGUOUS) {
            console.log("⚠️ [Phase 2] Ambiguous: multiple candidates with similar scores (possible duplicates)");
            const decision = {
                result: "AMBIGUOUS",
                phaseResolved: "PHASE_2",
                reason: `⚠️ Multiple matches found with similar scores (gap:${(gap * 100).toFixed(0)}%). Possible duplicates in Notion.`,
                phase2Candidates: candidates.length,
            };
            return {
                decision,
                candidates: top5,
            };
        }
        console.log("✅ [Phase 2] Confident fuzzy match found:", best?.filename || best?.title);
        const decision = {
            result: "FOUND",
            phaseResolved: "PHASE_2",
            reason: `🎯 Fuzzy match (score:${(bestScore * 100).toFixed(0)}%, gap:${(gap * 100).toFixed(0)}%) [${blockedStructuralMode ? "BLOCKED_STRUCTURAL" : "NORMAL"}] → ${best?._reasons?.join(", ") ?? "no reasons"}`,
            notionId: best.notion_id,
            notionUrl: best.url,
            displayName: best.title || best.filename || "Unknown",
            phase2Candidates: candidates.length,
        };
        return {
            decision,
            candidates: top5,
        };
    }
    // 2) NOTFOUND (mas manda TOP 5 pro Phase 3)
    console.log("⚠️ [Phase 2] No confident match, candidates:", candidates.length);
    const decision = {
        result: "NOTFOUND",
        phaseResolved: "PHASE_2",
        reason: `❌ No confident match for "${searchLabel}". Best: ${bestScore ? (bestScore * 100).toFixed(0) + "%" : "N/A"} (threshold: ${(THRESHOLD_FOUND * 100).toFixed(0)}%) [${blockedStructuralMode ? "BLOCKED_STRUCTURAL" : "NORMAL"}]`,
        phase2Candidates: candidates.length,
    };
    return {
        decision,
        candidates: top5,
    };
}
// -------------------------
// FUNÇÕES AUXILIARES
// -------------------------
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/['"«»]/g, "")
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function tokenize(text) {
    const stopwords = new Set([
        "the", "and", "for", "with",
        "mod", "mods",
        "pack", "set",
        "addon", "add-on",
        "download",
        "sims", "sims4",
        "cc",
    ]);
    return new Set(normalizeTitle(text)
        .split(/[\s\-_/]+/)
        .filter((token) => token.length >= 3 && !stopwords.has(token)));
}
function intersectionSize(setA, setB) {
    let count = 0;
    for (const item of setA)
        if (setB.has(item))
            count++;
    return count;
}
function unionSize(setA, setB) {
    return new Set([...setA, ...setB]).size;
}
function calculateSimilarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0)
        return 1.0;
    const distance = levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
}
function levenshteinDistance(s1, s2) {
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            }
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0)
            costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, "");
    }
    catch {
        return "";
    }
}
function looseDomainMatch(inputDomain, pageDomain) {
    const normalized = [inputDomain, pageDomain].map((d) => d.replace(/^www\./, "").toLowerCase());
    if (normalized[0] === normalized[1])
        return true;
    const commonPlatforms = [
        "curseforge.com",
        "patreon.com",
        "itch.io",
        "github.com",
        "modthesims.info",
    ];
    return commonPlatforms.some((platform) => normalized[0].includes(platform) && normalized[1].includes(platform));
}
