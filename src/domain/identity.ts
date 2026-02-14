// src/domain/identity.ts (VERSÃO CORRIGIDA - Cole exatamente)

export type UnfurlVia =
  | "og_web_scraper"
  | "local_ogs"
  | "iframely"
  | "fallback"
  | "notion_direct"
  | "none";

// domain/identity.ts
export interface Identity {  // ← MUDOU de type para interface
  url: string;
  domain: string;
  urlSlug: string;
  pageTitle: string | null;
  ogTitle: string | null;
  ogSite: string | null;
  creator?: string | null;  // ← ADICIONADO (corrige searchNotionCache.ts:20)
  isBlocked: boolean;
  unfurlVia: UnfurlVia;
  fallbackLabel: string;
  iframelySuggestion?: "hit" | "skip"; // novo campo opcional
}
