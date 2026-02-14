// src/phase2/searchNotionCache.ts (v3.1 - COM DETECÇÃO DE AMBIGUIDADE/DUPLICATAS - FIX THRESHOLD)

import type { Identity } from '../domain/identity.js';
import type { Decision } from '../domain/decision.js';
import type { NotionPage } from '../domain/snapshot.js';

export interface Phase2Result {
  decision: Decision;
  candidates?: NotionPage[];
}

export async function searchNotionCache(
  identity: Identity,
  notionPages: Record<string, NotionPage>
): Promise<Phase2Result> {
  
  const candidates: NotionPage[] = [];
  
  // ========== EXTRAÇÃO DE IDENTIDADE ==========
  const searchTitle = identity.pageTitle || identity.ogTitle || '';
  const searchCreator = identity.ogSite || '';
  const searchDomain = identity.domain;
  const searchSlug = identity.urlSlug;
  
  // Guard: sem título, impossível buscar
  if (!searchTitle) {
    return {
      decision: {
        result: 'NOT_FOUND',
        phaseResolved: 'PHASE_2',
        reason: '❌ No title available for matching (pageTitle and ogTitle both empty)'
      }
    };
  }
  
  console.log('🔍 [Phase 2] Fuzzy search for:', {
    title: searchTitle,
    creator: searchCreator || '(none)',
    domain: searchDomain,
    slug: searchSlug,
    totalPages: Object.keys(notionPages).length
  });
  
  // ========== TOKENIZAÇÃO PARA FALLBACK ==========
  const searchTokens = tokenize(searchTitle);
  
  // ========== SCORING FUZZY ==========
  for (const [notionId, page] of Object.entries(notionPages)) {
    let score = 0;
    const reasons: string[] = [];
    
    const notionTitle = page.title || page.filename;
    const notionCreator = page.creator || '';
    
    if (!notionTitle) continue;
    
    // --- 1. TÍTULO (peso 60%) via Levenshtein ---
    const titleSimilarity = calculateSimilarity(
      normalizeTitle(searchTitle),
      normalizeTitle(notionTitle)
    );
    
    // Match exato de título normalizado = retorno imediato
    if (titleSimilarity >= 0.98) {
      console.log('✅ [Phase 2] Near-exact title match:', notionTitle);
      return {
        decision: {
          result: 'FOUND',
          phaseResolved: 'PHASE_2',
          reason: `🎯 Exact name match: "${searchTitle}" ≈ "${notionTitle}"`,
          notionId: page.notionid,
          notionUrl: page.url,
          displayName: notionTitle
        }
      };
    }
    
    // --- FALLBACK: TOKEN OVERLAP quando Levenshtein falha ---
    let tokenOverlapScore = 0;
    if (titleSimilarity < 0.60) { // Só ativa fallback se Levenshtein baixo
      const notionTokens = tokenize(notionTitle);
      const overlap = intersectionSize(searchTokens, notionTokens);
      const union = unionSize(searchTokens, notionTokens);
      
      if (union > 0) {
        tokenOverlapScore = overlap / union; // Jaccard similarity
        
        // Se overlap alto, usa isso em vez de Levenshtein
        if (tokenOverlapScore >= 0.50) { // 50% dos tokens em comum
          score += tokenOverlapScore * 0.6;
          reasons.push(`tokens:${(tokenOverlapScore * 100).toFixed(0)}% (${overlap}/${union})`);
        } else {
          score += titleSimilarity * 0.6;
          if (titleSimilarity > 0.4) {
            reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
          }
        }
      } else {
        score += titleSimilarity * 0.6;
      }
    } else {
      score += titleSimilarity * 0.6;
      if (titleSimilarity > 0.4) {
        reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
      }
    }
    
    // --- 2. CREATOR (peso 20%) ---
    if (searchCreator && notionCreator) {
      const creatorSimilarity = calculateSimilarity(
        normalizeTitle(searchCreator),
        normalizeTitle(notionCreator)
      );
      score += creatorSimilarity * 0.2;
      if (creatorSimilarity > 0.5) {
        reasons.push(`creator:${(creatorSimilarity * 100).toFixed(0)}%`);
      }
    }
    
    // --- 3. SLUG (peso 15%) ---
    if (searchSlug && notionTitle) {
      const slugSimilarity = calculateSimilarity(
        normalizeTitle(searchSlug),
        normalizeTitle(notionTitle)
      );
      score += slugSimilarity * 0.15;
      if (slugSimilarity > 0.5) {
        reasons.push(`slug:${(slugSimilarity * 100).toFixed(0)}%`);
      }
    }
    
    // --- 4. DOMÍNIO (peso 5%, bonus) ---
    if (searchDomain && page.url) {
      const pageDomain = extractDomain(page.url);
      if (looseDomainMatch(searchDomain, pageDomain)) {
        score += 0.05;
        reasons.push('domain✓');
      }
    }
    
    // Adiciona candidato se score mínimo atingido
    if (score > 0.30) {
      const candidateWithMeta = { 
        ...page, 
        _score: score, 
        _reasons: reasons 
      };
      candidates.push(candidateWithMeta as NotionPage & { _score: number; _reasons: string[] });
    }
  }
  
  // ========== ORDENAÇÃO E DECISÃO ==========
  candidates.sort((a, b) => ((b as any)._score ?? 0) - ((a as any)._score ?? 0));
  
  const bestScore = candidates.length > 0 ? (candidates[0] as any)._score : 0;
  const best = candidates[0];
  
  console.log(`📊 [Phase 2] Found ${candidates.length} candidates, best score: ${(bestScore * 100).toFixed(0)}%`);
  
  // FOUND se score alto E único candidato claro
  if (candidates.length > 0 && bestScore >= 0.48) { // ← FIX: 0.50 → 0.48 (margem de segurança)
    const secondBest = candidates[1] ? (candidates[1] as any)._score : 0;
    const gap = bestScore - secondBest;
    
    // ========== NOVO: Detecção de Duplicatas/Empates ==========
    if (candidates.length > 1 && gap < 0.15) {
      // Empate ou duplicatas detectadas
      console.log('⚠️ [Phase 2] Ambiguous: multiple candidates with similar scores (possible duplicates)');
      
      return {
        decision: {
          result: 'AMBIGUOUS',
          phaseResolved: 'PHASE_2',
          reason: `⚠️ Multiple matches found with similar scores (gap:${(gap * 100).toFixed(0)}%). Possible duplicates in Notion.`,
          phase2Candidates: candidates.length
        },
        candidates: candidates.slice(0, 10) as NotionPage[] // Retorna todas as duplicatas
      };
    }
    
    // Match único e confiante
    if (candidates.length === 1 || gap > 0.15) {
      console.log('✅ [Phase 2] Confident fuzzy match found:', best.filename || best.title);
      return {
        decision: {
          result: 'FOUND',
          phaseResolved: 'PHASE_2',
          reason: `🎯 Fuzzy match (score:${(bestScore * 100).toFixed(0)}%, gap:${(gap * 100).toFixed(0)}%) → ${(best as any)._reasons?.join(', ')}`,
          notionId: best.notionid,
          notionUrl: best.url,
          displayName: best.title || best.filename || 'Unknown',
          phase2Candidates: candidates.length
        },
        candidates: candidates.slice(0, 5) as NotionPage[]
      };
    }
  }
  
  // NOT_FOUND → Phase 3 vai receber os candidatos
  console.log('⚠️ [Phase 2] No confident match, candidates:', candidates.length);
  return {
    decision: {
      result: 'NOT_FOUND',
      phaseResolved: 'PHASE_2',
      reason: `❌ No confident match for "${searchTitle}". Best: ${bestScore ? (bestScore * 100).toFixed(0) + '%' : 'N/A'} (threshold: 48%)`,
      phase2Candidates: candidates.length
    },
    candidates: candidates.slice(0, 10) as NotionPage[]
  };
}

// ========== FUNÇÕES AUXILIARES ==========

/**
 * Normaliza título: lowercase, remove pontuação (incluindo aspas e guillemets)
 * CORRIGIDO: agora remove ' " « » também
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['"«»''""]/g, '') // Remove aspas simples/duplas e guillemets
    .replace(/[^\w\s-]/g, '')   // Remove pontuação restante
    .replace(/\s+/g, ' ')       // Múltiplos espaços → 1
    .trim();
}

/**
 * Tokeniza string: quebra em palavras >= 3 chars, remove stopwords
 */
function tokenize(text: string): Set<string> {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'mod', 'pack', 'set']);
  
  return new Set(
    normalizeTitle(text)
      .split(/\s+/)
      .filter(token => token.length >= 3 && !stopwords.has(token))
  );
}

/**
 * Tamanho da interseção entre dois Sets
 */
function intersectionSize(setA: Set<string>, setB: Set<string>): number {
  let count = 0;
  for (const item of setA) {
    if (setB.has(item)) count++;
  }
  return count;
}

/**
 * Tamanho da união entre dois Sets
 */
function unionSize(setA: Set<string>, setB: Set<string>): number {
  const union = new Set([...setA, ...setB]);
  return union.size;
}

/**
 * Calcula similaridade Levenshtein normalizada (0.0 = diferente, 1.0 = idêntico)
 */
function calculateSimilarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/**
 * Distância de Levenshtein
 */
function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }
  return costs[s2.length];
}

/**
 * Extrai domínio limpo de URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Match loose de domínio
 */
function looseDomainMatch(inputDomain: string, pageDomain: string): boolean {
  const normalized = [inputDomain, pageDomain].map(d => 
    d.replace(/^www\./, '').toLowerCase()
  );
  
  if (normalized[0] === normalized[1]) return true;
  
  const commonPlatforms = ['curseforge.com', 'patreon.com', 'itch.io', 'github.com', 'modthesims.info'];
  return commonPlatforms.some(platform => 
    normalized[0].includes(platform) && normalized[1].includes(platform)
  );
}
