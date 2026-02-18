// src/domain/snapshot.ts

import type { Decision } from "./decision.js";

// ═══════════════════════════════════════════════════════════
// IDENTITY SNAPSHOT (já existia)
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// NOTION CACHE SNAPSHOT (novo - para Phase 2)
// ═══════════════════════════════════════════════════════════

export interface NotionPage {
  notion_id: string;
  url: string;
  title: string | null;
  filename: string | null;
  creator: string | null;
  created_time: string;
  last_edited_time: string;
  // Campos opcionais usados na Phase 2 para scoring
  _score?: number;
  _reasons?: string[];
}

export interface NotionCacheSnapshot {
  meta: {
    version: string;
    updatedAt: string;
  };

  // cache principal usado na Phase 2
  phase_2_cache: {
    pages: Record<string, NotionPage>;
  };

  // outros dados do snapshot.json
  phase_3_cache: Record<string, any>;
  canonical_log: Record<string, any>;
  notion_pages: Record<string, NotionPage>;
}
