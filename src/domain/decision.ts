// src/domain/decision.ts (v2.0.0 - Alinhado com novo pipeline)

// ═══════════════════════════════════════════════════════
// Fases oficiais do pipeline
// ═══════════════════════════════════════════════════════

export type Phase =
  | "PHASE_0"        // URL match determinístico
  | "PHASE_0_5"      // Slug match determinístico
  | "PHASE_1"        // analyzeUrl
  | "PHASE_2"        // Fuzzy snapshot search
  | "PHASE_2_5"      // Planejamento para Phase 3 (Notion live)
  | "PHASE_3"        // Confirmação / Desambiguação via Notion live
  | "REJECTED_404"   // URL inválida ou página inexistente
  | "PENDING_HUMAN"; // Revisão manual futura


// ═══════════════════════════════════════════════════════
// Resultados oficiais do analisador
// ═══════════════════════════════════════════════════════

export type DecisionResult =
  | "FOUND"
  | "AMBIGUOUS"
  | "NOTFOUND"
  | "REJECTED_404";


// ═══════════════════════════════════════════════════════
// Estrutura da decisão final
// ═══════════════════════════════════════════════════════

export interface Decision {
  result: DecisionResult;
  phaseResolved: Phase;
  reason: string;

  notionId?: string;
  notionUrl?: string;
  displayName?: string;

  // Quantidade de candidatos na Phase 2
  phase2Candidates?: number;

  // Para telemetria/debug
  phasesExecuted?: Phase[];

  // IA (legado / opcional)
  aiLog?: {
    stage: string;
    request: unknown;
    response: unknown;
  };

  // Compatibilidade antiga
  urlDiverge?: boolean;
}
