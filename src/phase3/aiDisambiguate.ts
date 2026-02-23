// src/phase3/aiDisambiguate.ts (v4.0 - Embeddings Xenova all-MiniLM-L6-v2)

import type { Identity } from '../domain/identity.js';
import type { NotionPage } from '../domain/snapshot.js';
import { getOrCreateEmbedding, cosineSimilarity } from '../embedding/embeddingEngine.js';
import { buildIdentityText, buildCandidateText } from '../embedding/textCanonicalizer.js';

export interface AIDisambiguationResult {
  matchedIndex: number;
  confidence: number;
  reason: string;
  rawResponse?: string;
}

/**
 * Verifica se a identidade é válida o suficiente pra usar IA
 * PATCH: Gate isBlocked REMOVIDO - se título é bom, não importa se bloqueado
 */
export function isIdentityValidForAI(identity: Identity): boolean {
  const title = identity.pageTitle || identity.ogTitle || '';

  // Guard 1: Título vazio ou muito curto
  if (title.length < 5) {
    console.log('⚠️ [Phase 3 Gate] Identity rejected: title too short');
    return false;
  }

  // Guard 2: Só números/pontuação (lixo)
  const cleanTitle = title.replace(/[^\w\s]/g, '').trim();
  if (/^\d+$/.test(cleanTitle)) {
    console.log('⚠️ [Phase 3 Gate] Identity rejected: title is only numbers');
    return false;
  }

  // Guard 3: Muito poucos caracteres alfabéticos (< 30%)
  const alphaCount = (title.match(/[a-zA-Z]/g) || []).length;
  const alphaRatio = alphaCount / title.length;

  if (alphaRatio < 0.3) {
    console.log(
      `⚠️ [Phase 3 Gate] Identity rejected: too few letters (${(alphaRatio * 100).toFixed(0)}%)`
    );
    return false;
  }

  // Gate 4 REMOVIDO: isBlocked não importa se o título é válido!

  console.log('✅ [Phase 3 Gate] Identity is valid for AI');
  return true;
}

export async function aiDisambiguate(
  identity: Identity,
  candidates: NotionPage[]
): Promise<AIDisambiguationResult> {
  if (candidates.length === 0) {
    return { matchedIndex: -1, confidence: 0, reason: 'No candidates provided' };
  }

  if (candidates.length === 1) {
    // ainda respeitamos threshold mínimo
    return await disambiguateSingle(identity, candidates[0]);
  }

  return await disambiguateMultiple(identity, candidates);
}

async function disambiguateSingle(
  identity: Identity,
  candidate: NotionPage
): Promise<AIDisambiguationResult> {
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

async function disambiguateMultiple(
  identity: Identity,
  candidates: NotionPage[]
): Promise<AIDisambiguationResult> {
  const idText = buildIdentityText(identity);
  const idEmb = await getOrCreateEmbedding(idText);

  const scores = await Promise.all(
    candidates.map(async (c, idx) => {
      const text = buildCandidateText(c);
      const emb = await getOrCreateEmbedding(text);
      return { idx, text, score: cosineSimilarity(idEmb, emb) };
    })
  );

  scores.sort((a, b) => b.score - a.score);

  const top1 = scores[0];
  const top2 = scores[1] ?? null;

  const T_HIGH = 0.75;
  const GAP = 0.1;

  if (top1.score >= T_HIGH && (!top2 || top1.score - top2.score >= GAP)) {
    return {
      matchedIndex: top1.idx,
      confidence: top1.score,
      reason: `Embedding matched candidate #${top1.idx} with ${(top1.score * 100).toFixed(1)}% similarity; gap ${(
        top2 ? (top1.score - top2.score) * 100 : 0
      ).toFixed(1)}%`,
      rawResponse: JSON.stringify({ idText, scores }),
    };
  }

  return {
    matchedIndex: -1,
    confidence: top1.score,
    reason: `Embedding ambiguity: top1 ${(top1.score * 100).toFixed(1)}% vs top2 ${(
      top2 ? top2.score * 100 : 0
    ).toFixed(1)}%`,
    rawResponse: JSON.stringify({ idText, scores }),
  };
}
