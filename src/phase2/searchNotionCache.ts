// src/phase2/searchNotionCache.ts (v3.2-beta FIXED - +PHASE 2.5 + TOP5 + CREATOR PESO PEQUENO + STATUS NOTFOUND)
//
// Decisões aplicadas:
// - Saídas do app: FOUND | AMBIGUOUS | NOTFOUND | REJECTED_404 (este arquivo cobre só Phase 2)
// - Creator do snapshot quase sempre null -> peso pequeno (0.05)
// - NOTFOUND retorna só TOP 5 melhores (não 10)
// - AMBIGUOUS também retorna TOP 5 (Phase 3 trabalha com 2..5)
// - Phase 2.5: planeja se chama Phase 3 (Notion live) para confirmar/desambiguar
//
// Opção B aplicada:
// ✅ Mantém _score/_reasons no retorno (NotionPage já suporta esses campos opcionais)
//   Isso ajuda debug e também ajuda cache/telemetria sem casts perigosos.

import type { Identity } from "../domain/identity.js";
import type { Decision } from "../domain/decision.js";
import type { NotionPage } from "../domain/snapshot.js";

// Tipo interno para garantir _score/_reasons durante o scoring
type ScoredNotionPage = NotionPage & {
  _score: number;
  _reasons: string[];
};

export interface Phase2Result {
  decision: Decision;
  candidates: NotionPage[]; // nunca undefined agora
}

const THRESHOLD_FOUND = 0.48;     // match alto o suficiente pra FOUND direto
const THRESHOLD_CANDIDATE = 0.28; // mínimo pra entrar como candidato
const GAP_AMBIGUOUS = 0.15;       // gap baixo => ambíguo/duplicata provável

// Pesos (somam ~0.85 + bônus domínio)
const W_TITLE = 0.60;
const W_CREATOR = 0.05; // PESO PEQUENO (snapshot quase sempre null)
const W_SLUG = 0.20;
const DOMAIN_BONUS = 0.05;

export async function searchNotionCache(
  identity: Identity,
  notionPages: Record<string, NotionPage>
): Promise<Phase2Result> {
  const candidates: ScoredNotionPage[] = [];

  // ========== EXTRAÇÃO DE IDENTIDADE ==========
  const searchTitle = identity.isBlocked
  ? `[${identity.domain}] ${identity.urlSlug}`  // Modo structural
  : (identity.pageTitle || identity.ogTitle || identity.urlSlug || "");

  // IMPORTANTE: creator real (quando existir) é identity.creator, não ogSite
  const searchCreator = identity.creator || "";

  const searchDomain = identity.domain;
  const searchSlug = identity.urlSlug;

  // Guard: sem título, impossível buscar
  if (!searchTitle && !identity.urlSlug) {
    return {
      decision: { result: "NOTFOUND", phaseResolved: "PHASE_2", reason: "..." },
      candidates: [],
    };
  }

  console.log("🔍 [Phase 2] Fuzzy search for:", {
    title: searchTitle,
    creator: searchCreator || "(none)",
    domain: searchDomain,
    slug: searchSlug,
    totalPages: Object.keys(notionPages).length,
  });

  // ========== TOKENIZAÇÃO PARA FALLBACK ==========
  const searchTokens = tokenize(searchTitle);

  // ========== SCORING FUZZY ==========
  for (const [, page] of Object.entries(notionPages)) {
    let score = 0;
    const reasons: string[] = [];

    const notionTitle = page.title || page.filename;
    const notionCreator = page.creator || "";

    if (!notionTitle) continue;

    // --- 1) TÍTULO (peso 60%) via Levenshtein + fallback token overlap ---
    const titleSimilarity = calculateSimilarity(
      normalizeTitle(searchTitle),
      normalizeTitle(notionTitle)
    );

    // Match quase exato de título = retorno imediato
    if (titleSimilarity >= 0.98 && !identity.isBlocked) {
      console.log("✅ [Phase 2] Near-exact title match:", notionTitle);

      const immediateDecision: Decision = {
        result: "FOUND",
        phaseResolved: "PHASE_2",
        reason: `🎯 Exact name match: "${searchTitle}" ≈ "${notionTitle}"`,
        notionId: page.notion_id,
        notionUrl: page.url, // se quiser consistência, troque pra getNotionPageUrl no main
        displayName: notionTitle,
        phase2Candidates: 1,
      };

      // Retorna o próprio page, sem score extra (não precisa)
      return {
        decision: immediateDecision,
        candidates: [page],
      };
    }

    // FALLBACK: token overlap quando Levenshtein é baixo
    if (titleSimilarity < 0.60) {
      const notionTokens = tokenize(notionTitle);
      const overlap = intersectionSize(searchTokens, notionTokens);
      const union = unionSize(searchTokens, notionTokens);

      if (union > 0) {
        const tokenOverlapScore = overlap / union; // Jaccard
        if (tokenOverlapScore >= 0.50) {
          score += tokenOverlapScore * W_TITLE * (identity.isBlocked ? 0 : 1); // bloqueados não ganham tanto do título
          reasons.push(`tokens:${(tokenOverlapScore * 100).toFixed(0)}% (${overlap}/${union})`);
        } else {
          score += titleSimilarity * W_TITLE * (identity.isBlocked ? 0 : 1); // se token overlap baixo, volta pro Levenshtein puro (mas bloqueados não ganham tanto)
          if (titleSimilarity > 0.40) reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
        }
      } else {
        score += titleSimilarity * W_TITLE * (identity.isBlocked ? 0 : 1); // sem overlap, volta pro Levenshtein puro
      }
    } else {
      score += titleSimilarity * W_TITLE * (identity.isBlocked ? 0 : 1); // match bom de título, mas bloqueados não ganham tanto
      if (titleSimilarity > 0.40) reasons.push(`title:${(titleSimilarity * 100).toFixed(0)}%`);
    }

    // --- 2) CREATOR (peso pequeno 5%) ---
    if (searchCreator && notionCreator) {
      const creatorSimilarity = calculateSimilarity(
        normalizeTitle(searchCreator),
        normalizeTitle(notionCreator)
      );
      score += creatorSimilarity * W_CREATOR;
      if (creatorSimilarity > 0.60) {
        reasons.push(`creator:${(creatorSimilarity * 100).toFixed(0)}%`);
      }
    }

    // --- 3) SLUG (peso 20% via token overlap) ---
    if (searchSlug && notionTitle) {
      const slugTokens = tokenize(searchSlug);
      const notionTokens = tokenize(notionTitle);

      const overlap = intersectionSize(slugTokens, notionTokens);
      const union = unionSize(slugTokens, notionTokens);

      if (union > 0) {
        const slugTokenScore = overlap / union;
        if (slugTokenScore > 0.50) {
          score += slugTokenScore * W_SLUG;
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

    // Entra na lista de candidatos
    if (score > THRESHOLD_CANDIDATE) {
      candidates.push({
        ...page,
        _score: score,
        _reasons: reasons,
      });
    }
  }

  // ========== ORDENAÇÃO (FIX CRÍTICO) ==========
  candidates.sort((a, b) => b._score - a._score);

  const best = candidates[0];
  const bestScore = best?._score ?? 0;
  const secondBestScore = candidates[1]?._score ?? 0;
  const gap = bestScore - secondBestScore;

  console.log(
    `📊 [Phase 2] Found ${candidates.length} candidates, best score: ${(
      bestScore * 100
    ).toFixed(0)}%`
  );

  // TOP 5 (mantém _score/_reasons pra debug)
  const top5: NotionPage[] = candidates.slice(0, 5);

  // ========== DECISÃO ==========
  // 1) FOUND direto: score alto e candidato claro
  if (candidates.length > 0 && bestScore >= THRESHOLD_FOUND) {
    // Ambíguo se segundo está perto demais
    if (candidates.length > 1 && gap < GAP_AMBIGUOUS) {
      console.log("⚠️ [Phase 2] Ambiguous: multiple candidates with similar scores (possible duplicates)");

      const decision: Decision = {
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

    const decision: Decision = {
      result: "FOUND",
      phaseResolved: "PHASE_2",
      reason: `🎯 Fuzzy match (score:${(bestScore * 100).toFixed(0)}%, gap:${(gap * 100).toFixed(0)}%) → ${best?._reasons?.join(", ") ?? "no reasons"}`,
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

  // 2) NOTFOUND: sem match confiante (mas manda TOP 5 pro Phase 3)
  console.log("⚠️ [Phase 2] No confident match, candidates:", candidates.length);

  const decision: Decision = {
    result: "NOTFOUND",
    phaseResolved: "PHASE_2",
    reason: `❌ No confident match for "${searchTitle}". Best: ${bestScore ? (bestScore * 100).toFixed(0) + "%" : "N/A"} (threshold: ${(THRESHOLD_FOUND * 100).toFixed(0)}%)`,
    phase2Candidates: candidates.length,
  };

  return {
    decision,
    candidates: top5,
  };
}

// -------------------------
// PHASE 2.5 (planejamento pro Phase 3)
// -------------------------



// -------------------------
// FUNÇÕES AUXILIARES
// -------------------------

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['"«»]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): Set<string> {
  const stopwords = new Set([
    "the", "and", "for", "with",
    "mod", "mods",
    "pack", "set",
    "addon", "add-on",
    "download",
    "sims", "sims4",
    "cc",
  ]);

  return new Set(
    normalizeTitle(text)
      .split(/[\s\-_/]+/)
      .filter((token) => token.length >= 3 && !stopwords.has(token))
  );
}

function intersectionSize(setA: Set<string>, setB: Set<string>): number {
  let count = 0;
  for (const item of setA) if (setB.has(item)) count++;
  return count;
}

function unionSize(setA: Set<string>, setB: Set<string>): number {
  return new Set([...setA, ...setB]).size;
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
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looseDomainMatch(inputDomain: string, pageDomain: string): boolean {
  const normalized = [inputDomain, pageDomain].map((d) =>
    d.replace(/^www\./, "").toLowerCase()
  );

  if (normalized[0] === normalized[1]) return true;

  const commonPlatforms = [
    "curseforge.com",
    "patreon.com",
    "itch.io",
    "github.com",
    "modthesims.info",
  ];

  return commonPlatforms.some(
    (platform) => normalized[0].includes(platform) && normalized[1].includes(platform)
  );
}
