// src/domain/decision.ts (v1.0.4 - COM AMBIGUOUS)

export type Phase = 
  | 'PHASE_0'        // URL match determinístico
  | 'PHASE_2'        // Fuzzy search no snapshot
  | 'PHASE_3'        // IA disambiguation
  | 'PHASE_3_IA'     // Legado (manter compatibilidade)
  | 'PENDING_HUMAN'; // Revisão manual

export type DecisionResult = "FOUND" | "NOT_FOUND" | "AMBIGUOUS"; // ← ADICIONADO 'AMBIGUOUS'

export interface Decision {
  result: DecisionResult;
  phaseResolved: Phase;
  reason: string;

  notionId?: string;
  notionUrl?: string;
  displayName?: string;

  phase2Candidates?: number;
  phasesExecuted?: Phase[];

  aiLog?: {
    stage: "PHASE_3_FALLBACK";
    request: unknown;
    response: unknown;
  };

  // Campos adicionados para compatibilidade com main.ts
  urlDiverge?: boolean;
}
