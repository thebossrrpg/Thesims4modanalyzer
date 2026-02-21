// src/domain/analyzerJsonOutput.ts
import type { Identity } from "./identity.js";

export type AnalyzerResultStatus =
  | "FOUND"
  | "AMBIGUOUS"
  | "NOTFOUND"
  | "REJECTED_404";

export type PhaseResolved =
  | "PHASE_0"
  | "PHASE_0_5"
  | "PHASE_2"
  | "PHASE_3"
  | "REJECTED_404";

// Você já tem um modelo de Identity no projeto; aqui a gente só referencia como "Identity".
//export type Identity = any;

export type ProviderUsed =
  | "og-web-api"
  | "localOgs"
  | "iframely"
  | "html";

export interface CandidateDebug {
  title: string;
  pageId: string;    // Notion pageId
  score: number;
}

export interface DebugValidation {
  isValidHttpUrl: boolean;
  rejected404Reason?: string; // aparece só se REJECTED_404
}

export interface DebugPhase0 {
  exactMatch: boolean;
  matchedPageId?: string; // se exactMatch = true
}

export interface DebugPhase05 {
  slugMatch: boolean;
  matchedPageId?: string; // se slugMatch = true
}

export interface DebugPhase1 {
  blocked: boolean;
  providersUsed: ProviderUsed[]; // só os que foram realmente usados
  identity: Identity;
}

export interface DebugPhase2 {
  candidatesCount: number;          // quantos acima do threshold forte
  candidatesTop5: CandidateDebug[]; // até 5, melhor->pior (acima do threshold forte)
}

export interface DebugPhase25 {
  candidatesCount: number;
  candidates: CandidateDebug[];
  selectionRule: "NONE" | "PLAN_TOP5" | "SANITY_TOPK" | "CONFIRM_SINGLE_WEAK" | "FALLBACK_TOP2";
}

export interface DebugPhase3 {
  mode: "online" | "offline";

  cacheUsed?: boolean;
  cacheHit?: { hit: number; total: number };

  notionApi?: { fetchedPages: number };

  finalCandidates: number; // 1 => FOUND, >1 => AMBIGUOUS. 0 => BUG (não esperado)
  finalCandidatePageIds?: string[];
}

export interface DebugExpander {
  validation: DebugValidation;
  phase0?: DebugPhase0;
  phase05?: DebugPhase05;
  phase1?: DebugPhase1;
  phase2?: DebugPhase2;
  phase25?: DebugPhase25; // só se phase2.candidatesCount = 0 (quando existir)
  phase3?: DebugPhase3;   // só se chegou até a 3
}

export interface AnalyzerJsonOutput {
  startedAt: string;
  inputUrl: string;

  status: AnalyzerResultStatus;
  phaseResolved: PhaseResolved;

  reason?: string;

  meta?: {
    decisionCache?: { hit: boolean; key?: string };
    aiDecisionCache?: { hit: boolean; key?: string };
  };

  debug: DebugExpander;

  found?: {
    pageId: string;
    pageUrl?: string;
    title?: string;
  };

  ambiguous?: {
    pageIds: string[];
  };
}
