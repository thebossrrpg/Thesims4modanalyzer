// src/phase3/aiDisambiguate.ts (v3.2 - GATE isBlocked REMOVIDO)

import type { Identity } from '../domain/identity.js';
import type { NotionPage } from '../domain/snapshot.js';

const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_API_URL = 'https://router.huggingface.co/hf-inference/models/facebook/bart-large-mnli';

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
    console.log(`⚠️ [Phase 3 Gate] Identity rejected: too few letters (${(alphaRatio * 100).toFixed(0)}%)`);
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
    return {
      matchedIndex: -1,
      confidence: 0,
      reason: 'No candidates provided'
    };
  }
  
  if (candidates.length === 1) {
    return {
      matchedIndex: 0,
      confidence: 1.0,
      reason: 'Only one candidate available'
    };
  }
  
  console.log('🤖 [Phase 3] Calling Hugging Face BART-MNLI...');
  
  const inputText = buildInputText(identity);
  const candidateLabels = candidates.map((c, i) => {
    const title = c.title || c.filename || 'Unknown';
    const url = c.url || '';
    let domain = '';
    try {
      domain = new URL(url).hostname.replace('www.', '');
    } catch {}
    return `${title} from ${domain}`;
  });
  
  try {
    const response = await fetch(HF_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: inputText,
        parameters: {
          candidate_labels: candidateLabels
        }
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('❌ [Phase 3] HF API error:', error);
      return {
        matchedIndex: -1,
        confidence: 0,
        reason: `HF API error: ${response.status}`
      };
    }
    
    const data = await response.json();
    console.log('🤖 [Phase 3] BART response:', JSON.stringify(data, null, 2));
    
    const result = parseBARTResponse(data, candidateLabels, candidates);
    result.rawResponse = JSON.stringify(data);
    
    return result;
    
  } catch (error) {
    console.error('❌ [Phase 3] HF API call failed:', error);
    return {
      matchedIndex: -1,
      confidence: 0,
      reason: `API call failed: ${error}`
    };
  }
}

function buildInputText(identity: Identity): string {
  const title = identity.pageTitle || identity.ogTitle || '';
  const domain = identity.domain || '';
  
  return `${title} from ${domain}`;
}

function parseBARTResponse(
  data: any,
  candidateLabels: string[],
  candidates: NotionPage[]
): AIDisambiguationResult {
  if (!Array.isArray(data) || data.length === 0) {
    return {
      matchedIndex: -1,
      confidence: 0,
      reason: 'Invalid BART response format'
    };
  }
  
  const bestMatch = data[0];
  const bestScore = bestMatch.score;
  const bestLabel = bestMatch.label;
  
  const matchedIndex = candidateLabels.indexOf(bestLabel);
  
  if (matchedIndex === -1) {
    return {
      matchedIndex: -1,
      confidence: 0,
      reason: 'Could not match BART label to candidate'
    };
  }
  
  // Threshold: score precisa ser ≥ 55%
  if (bestScore < 0.55) {
    return {
      matchedIndex: -1,
      confidence: bestScore,
      reason: `Best match score too low: ${(bestScore * 100).toFixed(1)}%`
    };
  }
  
  const candidateTitle = candidates[matchedIndex].title || candidates[matchedIndex].filename;
  
  return {
    matchedIndex,
    confidence: bestScore,
    reason: `BART matched "${candidateTitle}" with ${(bestScore * 100).toFixed(1)}% confidence`
  };
}
