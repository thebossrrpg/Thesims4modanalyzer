export type UnfurlVia =
  | "og_web_scraper"
  | "local_ogs"
  | "iframely"
  | "fallback"
  | "notion_direct"
  | "none";


// domain/identity.ts
export type Identity = {
  url: string;
  domain: string;
  urlSlug: string;
  pageTitle: string | null;
  ogTitle: string | null;
  ogSite: string | null;
  isBlocked: boolean;
  unfurlVia: UnfurlVia;
  fallbackLabel: string;
  iframelySuggestion?: "hit" | "skip"; // novo campo opcional
};

