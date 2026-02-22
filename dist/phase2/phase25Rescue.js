// src/phase2/phase25Rescue.ts
//
// Phase 2.5 — "Rescue" (puro, sem IO)
//
// Objetivo:
// - Normalizar/ajustar o conjunto de candidatos que saiu da Phase 2
// - Garantir um conjunto "bom o suficiente" e pequeno (2..5) para a Phase 3
// - Quando houver só 1 candidato fraco, marcar como CONFIRM_SINGLE_WEAK
// - Quando houver 2..5, marcar como DISAMBIGUATE
// - Quando não houver nada, SKIP
//
// Importante:
// - Este arquivo NÃO decide FOUND/AMBIGUOUS/NOTFOUND. Quem decide é o main.ts
//   + Phase 2 (fuzzy snapshot) + Phase 3 (AI/notion-live).
// - Aqui a gente só cria um "plano" + uma lista saneada de candidatos para fase seguinte.
//
// Alinhado com o contrato atual (Phase2_5Plan / Phase2Result.phase25) do searchNotionCache.ts.
//
// Regras (versão beta, pragmática):
// 1) Se Phase 2 já retornou candidates 2..5 → só “passa adiante” (PLAN_TOP5).
// 2) Se veio 1 candidato:
//    - se score >= strongThreshold → não precisa Phase 3 (SKIP)
//    - senão → CONFIRM_SINGLE_WEAK (manda 1 candidato)
// 3) Se veio 0 candidato:
//    - tenta resgatar pegando os “melhores por score” se existirem (em geral não existem se o Phase 2 já cortou),
//      então aqui só retorna SKIP.
//    - (O resgate real, quando você quiser, seria: Phase 2 rodar um segundo scoring com threshold menor.
//       Isso fica fora daqui — e é por isso que este módulo é puro.)
//
// 4) Se veio > 5 → corta pra 5 (SANITY_TOPK).
//
// Observação sobre score:
// - NotionPage tem _score opcional. Se não tiver, a gente considera 0.
/** Leitura segura de score (NotionPage._score é opcional). */
function scoreOf(p) {
    const s = p?._score;
    return typeof s === "number" && Number.isFinite(s) ? s : 0;
}
function sortByScoreDesc(pages) {
    return [...pages].sort((a, b) => scoreOf(b) - scoreOf(a));
}
function topK(pages, k) {
    return pages.slice(0, Math.max(0, k));
}
/**
 * Dado o conjunto de candidatos da Phase 2 (já top5 normalmente),
 * calcula plano e garante 0..maxCandidates, tipicamente 2..5 ou 1 (confirm weak).
 */
export function phase25Rescue(phase2Candidates, opts) {
    const strongThreshold = opts?.strongThreshold ?? 0.48; // alinhado com THRESHOLD_FOUND
    const maxCandidates = opts?.maxCandidates ?? 5;
    const total = phase2Candidates.length;
    // Ordena por score (caso venha fora de ordem)
    const ordered = sortByScoreDesc(phase2Candidates);
    const bestScore = ordered[0] ? scoreOf(ordered[0]) : 0;
    const secondBestScore = ordered[1] ? scoreOf(ordered[1]) : 0;
    const gap = bestScore - secondBestScore;
    // 0 candidatos => nada para fazer
    if (ordered.length === 0) {
        return {
            candidates: [],
            selectionRule: "NONE",
            plan: {
                shouldCallPhase3: false,
                mode: "SKIP",
                reason: "No candidates from Phase 2 (nothing to confirm/disambiguate).",
                phase3Candidates: [],
                bestScore,
                secondBestScore,
                gap,
                totalCandidatesScored: total,
            },
        };
    }
    // 1 candidato
    if (ordered.length === 1) {
        // Se for "forte", não precisa Phase 3 (Phase 2 já deveria ter resolvido, mas aqui é defensivo)
        if (bestScore >= strongThreshold) {
            const only = topK(ordered, 1);
            return {
                candidates: only,
                selectionRule: "PLAN_TOP5",
                plan: {
                    shouldCallPhase3: false,
                    mode: "SKIP",
                    reason: "Single strong candidate; Phase 2 already effectively confident.",
                    phase3Candidates: only,
                    bestScore,
                    secondBestScore,
                    gap,
                    totalCandidatesScored: total,
                },
            };
        }
        // Candidato único fraco => confirmar no Notion live
        const only = topK(ordered, 1);
        return {
            candidates: only,
            selectionRule: "CONFIRM_SINGLE_WEAK",
            plan: {
                shouldCallPhase3: true,
                mode: "CONFIRM_SINGLE_WEAK",
                reason: "Single weak candidate; confirm in Phase 3 (Notion live by pageId).",
                phase3Candidates: only,
                bestScore,
                secondBestScore,
                gap,
                totalCandidatesScored: total,
            },
        };
    }
    // 2..N candidatos => corta e manda para desambiguação
    const clipped = ordered.length > maxCandidates ? topK(ordered, maxCandidates) : ordered;
    const selectionRule = ordered.length > maxCandidates ? "SANITY_TOPK" : "PLAN_TOP5";
    return {
        candidates: clipped,
        selectionRule,
        plan: {
            shouldCallPhase3: true,
            mode: "DISAMBIGUATE",
            reason: "Multiple candidates; disambiguate in Phase 3 (Notion live by pageId).",
            phase3Candidates: clipped,
            bestScore,
            secondBestScore,
            gap,
            totalCandidatesScored: total,
        },
    };
}
