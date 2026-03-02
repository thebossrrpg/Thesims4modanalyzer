// src/phase3/aiDisambiguate.ts (v4.2 - Embeddings Xenova all-MiniLM-L6-v2 + Gate anti-challenge)
import { getOrCreateEmbedding, cosineSimilarity } from '../embedding/embeddingEngine.js';
import { buildIdentityText, buildCandidateText } from '../embedding/textCanonicalizer.js';
const CHALLENGE_TITLE_PATTERNS = [
    /just a moment/i,
    /security checkpoint/i,
    /vercel security checkpoint/i,
    /attention required/i,
    /checking (your )?browser/i,
    /verify (you are )?human/i,
    /human verification/i,
    /bot verification/i,
    /access denied/i,
    /request blocked/i,
    /ddos protection/i,
    /cloudflare/i,
    /challenge/i,
];
function isChallengeTitle(title) {
    const t = String(title ?? '').trim();
    if (!t)
        return false;
    return CHALLENGE_TITLE_PATTERNS.some((rx) => rx.test(t));
}
function getBestIdentityTitle(identity) {
    return String(identity.pageTitle || identity.ogTitle || '').trim();
}
/**
 * Verifica se a identidade é válida o suficiente pra usar IA (embeddings)
 * - isBlocked sozinho NÃO reprova automaticamente
 * - título de challenge/checkpoint reprova
 */
export function isIdentityValidForAI(identity) {
    const title = getBestIdentityTitle(identity);
    // Guard 0: challenge/checkpoint
    if (isChallengeTitle(title)) {
        console.log(`⚠️ [Phase 3 Gate] Identity rejected: challenge/checkpoint title detected ("${title}")`);
        return false;
    }
    // Guard 1: título vazio ou muito curto
    if (title.length < 5) {
        console.log('⚠️ [Phase 3 Gate] Identity rejected: title too short');
        return false;
    }
    // Guard 2: só números/pontuação
    const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
    if (!cleanTitle) {
        console.log('⚠️ [Phase 3 Gate] Identity rejected: title became empty after cleanup');
        return false;
    }
    if (/^\d+$/.test(cleanTitle)) {
        console.log('⚠️ [Phase 3 Gate] Identity rejected: title is only numbers');
        return false;
    }
    // Guard 3: poucos caracteres alfabéticos
    const alphaCount = (title.match(/[a-zA-Z]/g) || []).length;
    const alphaRatio = title.length > 0 ? alphaCount / title.length : 0;
    if (alphaRatio < 0.3) {
        console.log(`⚠️ [Phase 3 Gate] Identity rejected: too few letters (${(alphaRatio * 100).toFixed(0)}%)`);
        return false;
    }
    // isBlocked continua NÃO sendo bloqueio automático
    console.log('✅ [Phase 3 Gate] Identity is valid for AI');
    return true;
}
export async function aiDisambiguate(identity, candidates) {
    if (!isIdentityValidForAI(identity)) {
        return { matchedIndex: -1, confidence: 0, reason: 'Identity too weak for AI' };
    }
    if (candidates.length === 0) {
        return { matchedIndex: -1, confidence: 0, reason: 'No candidates provided' };
    }
    if (candidates.length === 1) {
        return await disambiguateSingle(identity, candidates[0]);
    }
    return await disambiguateMultiple(identity, candidates);
}
async function disambiguateSingle(identity, candidate) {
    const idText = buildIdentityText(identity);
    const candText = buildCandidateText(candidate);
    const [idEmb, candEmb] = await Promise.all([
        getOrCreateEmbedding(idText),
        getOrCreateEmbedding(candText),
    ]);
    const score = cosineSimilarity(idEmb, candEmb);
    const T_CONFIRM = 0.7; // calibrável
    if (score >= T_CONFIRM) {
        return {
            matchedIndex: 0,
            confidence: score,
            reason: `Single candidate confirmed by embedding similarity ${(score * 100).toFixed(1)}%`,
            rawResponse: JSON.stringify({ idText, candText, score }),
        };
    }
    return {
        matchedIndex: -1,
        confidence: score,
        reason: `Single candidate similarity too low: ${(score * 100).toFixed(1)}%`,
        rawResponse: JSON.stringify({ idText, candText, score }),
    };
}
async function disambiguateMultiple(identity, candidates) {
    const idText = buildIdentityText(identity);
    const idEmb = await getOrCreateEmbedding(idText);
    const scores = await Promise.all(candidates.slice(0, 5).map(async (c, idx) => {
        const text = buildCandidateText(c);
        const emb = await getOrCreateEmbedding(text);
        return { idx, text, score: cosineSimilarity(idEmb, emb) };
    }));
    scores.sort((a, b) => b.score - a.score);
    const top1 = scores[0];
    const top2 = scores[1] ?? null;
    const T_HIGH = 0.75;
    const GAP = 0.1;
    if (top1.score >= T_HIGH && (!top2 || top1.score - top2.score >= GAP)) {
        return {
            matchedIndex: top1.idx,
            confidence: top1.score,
            reason: `Embedding matched candidate #${top1.idx} with ${(top1.score * 100).toFixed(1)}% similarity; gap ${(top2 ? (top1.score - top2.score) * 100 : 0).toFixed(1)}%`,
            rawResponse: JSON.stringify({ idText, scores }),
        };
    }
    return {
        matchedIndex: -1,
        confidence: top1.score,
        reason: `Embedding ambiguity: top1 ${(top1.score * 100).toFixed(1)}% vs top2 ${(top2 ? top2.score * 100 : 0).toFixed(1)}%`,
        rawResponse: JSON.stringify({ idText, scores }),
    };
}
