export type Phase = "PHASE_2" | "PHASE_3";

export type DecisionResult = "FOUND" | "NOT_FOUND";

export type Decision = {
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
};
