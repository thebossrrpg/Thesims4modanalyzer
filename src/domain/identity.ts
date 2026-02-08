export type UnfurlVia = "og_web_scraper" | "local_ogs" | "iframely" | "fallback" | "none";

export type Identity = {
  url: string;
  domain: string;
  urlSlug: string;

  pageTitle: string | null;
  ogTitle: string | null;
  ogSite: string | null;

  isBlocked: boolean;

  fallbackLabel?: string;
  unfurlVia?: UnfurlVia;
};

