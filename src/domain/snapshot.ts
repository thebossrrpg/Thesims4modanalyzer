// src/domain/snapshot.ts

import type { Decision } from "./decision.js";

export interface IdentitySnapshot {
  url: string;
  domain: string;
  urlSlug: string;
  pageTitle: string | null;
  ogTitle: string | null;
  ogSite: string | null;
  isBlocked: boolean;
}

export interface Snapshot {
  identity: IdentitySnapshot;
  decision: Decision;
  createdAt: Date;
}
