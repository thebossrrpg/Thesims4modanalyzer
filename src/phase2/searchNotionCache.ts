// src/phase2/searchNotionCache.ts

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
  
  const searchTitle = identity.pageTitle || identity.ogTitle;
  const searchDomain = identity.domain;
  const searchSlug = identity.urlSlug;
  const searchSite = identity.ogSite;
  
  if (!searchTitle) {
    return {
      decision: {
        result: 'NOT_FOUND',
        phaseResolved: 'PHASE_2',
        reason: 'No title available for matching'
      }
    };
  }
  
  for (const [notionId, page] of Object.entries(notionPages)) {
    let score = 0;
    const reasons: string[] = [];
    
    const notionTitle = page.title || page.filename;
    if (!notionTitle) continue;
    
    // 1. TÍTULO (70%)
    const titleSimilarity = calculateSimilarity(
      normalizeTitle(searchTitle),
      normalizeTitle(notionTitle)
    );
    
    if (titleSimilarity === 1.0) {
      return {
        decision: {
          result: 'FOUND',
          phaseResolved: 'PHASE_2',
          reason: `Exact title match: "${searchTitle}"`,
          notionId: page.notionid,
          notionUrl: page.url,
          displayName: notionTitle
        }
      };
    }
    
    score += titleSimilarity * 0.7;
    if (titleSimilarity > 0.6) {
      reasons.push(`title: ${(titleSimilarity * 100).toFixed(0)}%`);
    }
    
    // 2. DOMÍNIO (15%)
    if (searchDomain && page.url) {
      const pageDomain = extractDomain(page.url);
      if (pageDomain === searchDomain) {
        score += 0.15;
        reasons.push('same domain');
      }
    }
    
    // 3. SLUG (10%)
    if (searchSlug && page.url) {
      const pageSlug = extractSlug(page.url);
      if (pageSlug) {
        const slugSimilarity = calculateSimilarity(
          normalizeTitle(searchSlug),
          normalizeTitle(pageSlug)
        );
        score += slugSimilarity * 0.1;
        if (slugSimilarity > 0.6) {
          reasons.push(`slug: ${(slugSimilarity * 100).toFixed(0)}%`);
        }
      }
    }
    
    // 4. OG:SITE (5%)
    if (searchSite && page.url) {
      const normalizedSite = searchSite.toLowerCase().replace(/\s/g, '');
      if (page.url.toLowerCase().includes(normalizedSite)) {
        score += 0.05;
        reasons.push('site match');
      }
    }
    
    if (score > 0.6) {
      const candidate = page;
      candidate._score = score;
      candidate._reasons = reasons;
      candidates.push(candidate);
    }
  }
  
  candidates.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  
  if (candidates.length > 0 && (candidates[0]._score ?? 0) > 0.85) {
    const best = candidates[0];
    return {
      decision: {
        result: 'FOUND',
        phaseResolved: 'PHASE_2',
        reason: `Multi-factor match (score: ${((best._score ?? 0) * 100).toFixed(0)}%): ${best._reasons?.join(', ')}`,
        notionId: best.notionid,
        notionUrl: best.url,
        displayName: best.title || best.filename || 'Unknown',
        phase2Candidates: candidates.length
      },
      candidates: candidates.slice(0, 5)
    };
  }
  
  return {
    decision: {
      result: 'NOT_FOUND',
      phaseResolved: 'PHASE_2',
      reason: `No confident match found for "${searchTitle}". Best score: ${candidates.length > 0 ? ((candidates[0]._score ?? 0) * 100).toFixed(0) + '%' : 'N/A'}`,
      phase2Candidates: candidates.length
    },
    candidates: candidates.slice(0, 10)
  };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function calculateSimilarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

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
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function extractSlug(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/[\/\-_]/g, ' ').trim();
  } catch {
    return '';
  }
}
