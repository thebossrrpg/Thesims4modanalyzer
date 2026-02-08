import ogs from "open-graph-scraper";
import fs from "node:fs";
import path from "node:path";
import type { Identity, UnfurlVia } from "../domain/identity.js";

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7"
};

const BLOCKED_PATTERNS =
  /(just a moment|cloudflare|access denied|checking your browser)/i;

type UnfurlMeta = {
  title: string | null;
  ogTitle: string | null;
  ogSite: string | null;
  via: UnfurlVia;
};

type ProviderKey = "ogWebApi" | "localOgs";
type ProviderState = { blockedUntilMs: number };

const providerState: Record<ProviderKey, ProviderState> = {
  ogWebApi: { blockedUntilMs: 0 },
  localOgs: { blockedUntilMs: 0 }
};

type CacheEntry = { expiresAtMs: number; meta: UnfurlMeta };
const unfurlCache = new Map<string, CacheEntry>();

// ===== Iframely usage persistence (apenas leitura para sugestão) =====

type IframelyUsage = {
  month: string; // YYYY-MM
  hits: number;
  cooldownUntilMs?: number;
};

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const IFRAMELY_USAGE_FILE = path.join(CACHE_DIR, "iframely-usage.json");
const NOTIONCACHE_FILE = path.join(CACHE_DIR, "notioncache.json");

// ===== Debug helper =====

function debugLog(msg: string): void {
  if (process.env.UNFURL_DEBUG === "1") {
    console.error(msg);
  }
}

function ensureCacheDir(): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function currentMonthKey(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function readIframelyUsage(): IframelyUsage {
  ensureCacheDir();
  const month = currentMonthKey();

  try {
    const raw = fs.readFileSync(IFRAMELY_USAGE_FILE, "utf-8");
    const data = JSON.parse(raw) as IframelyUsage;
    if (!data || typeof data !== "object") return { month, hits: 0 };
    if (data.month !== month) return { month, hits: 0 };
    return {
      month,
      hits: Number.isFinite(data.hits) ? data.hits : 0,
      cooldownUntilMs:
        typeof data.cooldownUntilMs === "number" ? data.cooldownUntilMs : undefined
    };
  } catch {
    return { month, hits: 0 };
  }
}

function getIframelySoftLimit(): number {
  const v = Number(process.env.IFRAMELY_SOFT_LIMIT ?? "700");
  return Number.isFinite(v) && v >= 0 ? v : 700;
}

function nowMs(): number {
  return Date.now();
}

function canTry(provider: ProviderKey): boolean {
  return nowMs() >= providerState[provider].blockedUntilMs;
}

function cooldown(provider: ProviderKey, ms: number): void {
  providerState[provider].blockedUntilMs = nowMs() + ms;
}

function buildSlugFromPath(pathname: string): string {
  return pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim() || null;
}

/**
 * Extrai meta content por:
 * - property="og:title"
 * - property="og:site_name"
 * - name="og:title" (fallback)
 */
function extractMetaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m?.[1]?.trim() || null;
}

function detectBlocked(htmlLower: string, pageTitleLower: string | null): boolean {
  if (BLOCKED_PATTERNS.test(htmlLower)) return true;
  if (pageTitleLower && BLOCKED_PATTERNS.test(pageTitleLower)) return true;
  return false;
}

function isUselessText(s: string | null): boolean {
  if (!s) return true;
  return BLOCKED_PATTERNS.test(s);
}

function isUsefulMeta(meta: UnfurlMeta): boolean {
  const best = meta.ogTitle || meta.title || null;
  if (!best) return false;
  if (isUselessText(best)) return false;
  return true;
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    debugLog(`[unfurl] fetchHtml start url=${url}`);
    const res = await fetch(url, {
      method: "GET",
      headers: REQUEST_HEADERS,
      redirect: "follow",
      signal: controller.signal
    });

    const text = await res.text();
    debugLog(
      `[unfurl] fetchHtml done url=${url} status=${res.status} length=${text.length}`
    );
    return text || "";
  } catch (err) {
    debugLog(`[unfurl] fetchHtml error url=${url} err=${String(err)}`);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMeta(meta: Partial<UnfurlMeta>, via: UnfurlVia): UnfurlMeta {
  return {
    title: meta.title ?? null,
    ogTitle: meta.ogTitle ?? null,
    ogSite: meta.ogSite ?? null,
    via
  };
}

function getCachedUnfurl(url: string): UnfurlMeta | null {
  const entry = unfurlCache.get(url);
  if (!entry) return null;
  if (nowMs() > entry.expiresAtMs) {
    unfurlCache.delete(url);
    return null;
  }
  return entry.meta;
}

function setCachedUnfurl(url: string, meta: UnfurlMeta, ttlMs: number): void {
  unfurlCache.set(url, { meta, expiresAtMs: nowMs() + ttlMs });
}

// ===== Notioncache pré-fase 1 =====

type NotionPage = {
  notion_id: string;
  created_time?: string;
  last_edited_time?: string;
  filename?: string | null;
  url?: string | null;
  creator?: string | null;
};

type NotionCache = {
  pages?: Record<string, NotionPage>;
};

let notionCacheLoaded = false;
let notionCache: NotionCache | null = null;

function loadNotionCache(): void {
  if (notionCacheLoaded) return;
  notionCacheLoaded = true;
  try {
    ensureCacheDir();
    const raw = fs.readFileSync(NOTIONCACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as NotionCache;
    if (!data || typeof data !== "object") {
      debugLog("[unfurl] notioncache invalid structure");
      notionCache = null;
      return;
    }
    notionCache = data;
    debugLog("[unfurl] notioncache loaded");
  } catch (err) {
    debugLog(`[unfurl] notioncache load failed err=${String(err)}`);
    notionCache = null;
  }
}

function tryNotionIdentity(url: string): Identity | null {
  loadNotionCache();
  if (!notionCache || !notionCache.pages) {
    debugLog("[unfurl] notion_direct skipped (no pages)");
    return null;
  }

  const pages = Object.values(notionCache.pages);
  const match = pages.find((p) => p.url && p.url === url);
  if (!match || !match.url) {
    debugLog("[unfurl] notion_direct no-match");
    return null;
  }

  const parsed = new URL(match.url);
  const domain = parsed.hostname.replace(/^www\./, "");
  const urlSlug = buildSlugFromPath(parsed.pathname);
  const title = (match.filename ?? "").trim() || null;

  debugLog(
    `[unfurl] notion_direct match notion_id=${match.notion_id} filename=${match.filename ?? ""}`
  );

  const identity: Identity = {
    url: match.url,
    domain,
    urlSlug: urlSlug || "—",
    pageTitle: title,
    ogTitle: title,
    ogSite: "NotionCache",
    isBlocked: false,
    unfurlVia: "notion_direct",
    fallbackLabel: `${domain} · ${urlSlug || "—"}`
  };

  return identity;
}

// ===== Providers =====

// 1) FREE: og-web-scraper-api.vercel.app
async function tryOgWebApi(url: string): Promise<UnfurlMeta | null> {
  debugLog(`[unfurl] tryOgWebApi url=${url}`);
  const endpoint = `https://og-web-scraper-api.vercel.app/scrape?url=${encodeURIComponent(
    url
  )}`;
  const res = await fetch(endpoint, { method: "GET" });

  if (!res.ok) {
    debugLog(`[unfurl] ogWebApi http=${res.status}`);
    if (res.status === 429) throw new Error("OGWEB_RATE_LIMIT");
    if (res.status === 403) throw new Error("OGWEB_FORBIDDEN");
    return null;
  }

  const data = (await res.json()) as any;

  const title =
    (typeof data?.ogTitle === "string" ? data.ogTitle : null) ??
    (typeof data?.title === "string" ? data.title : null) ??
    (typeof data?.itemTitle === "string" ? data.itemTitle : null) ??
    null;

  const ogSite =
    (typeof data?.ogSiteName === "string" ? data.ogSiteName : null) ??
    (typeof data?.og?.site_name === "string" ? data.og.site_name : null) ??
    null;

  const meta = normalizeMeta({ title, ogTitle: title, ogSite }, "og_web_scraper");
  if (!isUsefulMeta(meta)) {
    debugLog("[unfurl] ogWebApi useless-meta");
    return null;
  }
  debugLog("[unfurl] ogWebApi success");
  return meta;
}

// 2) FREE: open-graph-scraper local
async function tryLocalOgs(url: string): Promise<UnfurlMeta | null> {
  debugLog(`[unfurl] tryLocalOgs url=${url}`);
  const result = await ogs({
    url,
    timeout: 8000,
    onlyGetOpenGraphInfo: true,
    fetchOptions: { headers: REQUEST_HEADERS }
  });

  const r: any = result?.result ?? null;
  if (!r) {
    debugLog("[unfurl] localOgs no-result");
    return null;
  }

  const meta = normalizeMeta(
    {
      title: typeof r.title === "string" ? r.title : null,
      ogTitle: typeof r.ogTitle === "string" ? r.ogTitle : null,
      ogSite: typeof r.ogSiteName === "string" ? r.ogSiteName : null
    },
    "local_ogs"
  );

  if (!isUsefulMeta(meta)) {
    debugLog("[unfurl] localOgs useless-meta");
    return null;
  }
  debugLog("[unfurl] localOgs success");
  return meta;
}

async function unfurlBlocked(url: string): Promise<UnfurlMeta | null> {
  const cached = getCachedUnfurl(url);
  if (cached) {
    debugLog(`[unfurl] cache hit via=${cached.via} url=${url}`);
    return cached;
  }

  const GOOD_TTL = 6 * 60 * 60_000;

  if (canTry("ogWebApi")) {
    debugLog("[unfurl] provider=ogWebApi eligible");
    try {
      const meta = await tryOgWebApi(url);
      if (meta) {
        setCachedUnfurl(url, meta, GOOD_TTL);
        return meta;
      }
      cooldown("ogWebApi", 5 * 60_000);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      debugLog(`[unfurl] ogWebApi error msg=${msg}`);
      cooldown("ogWebApi", msg.includes("RATE_LIMIT") ? 30 * 60_000 : 10 * 60_000);
    }
  } else {
    debugLog("[unfurl] provider=ogWebApi on-cooldown");
  }

  if (canTry("localOgs")) {
    debugLog("[unfurl] provider=localOgs eligible");
    try {
      const meta = await tryLocalOgs(url);
      if (meta) {
        setCachedUnfurl(url, meta, GOOD_TTL);
        return meta;
      }
      cooldown("localOgs", 2 * 60_000);
    } catch (e: any) {
      debugLog(`[unfurl] localOgs error msg=${String(e)}`);
      cooldown("localOgs", 2 * 60_000);
    }
  } else {
    debugLog("[unfurl] provider=localOgs on-cooldown");
  }

  debugLog("[unfurl] all providers exhausted, returning null");
  return null;
}

export async function analyzeUrl(url: string): Promise<Identity> {
  debugLog(`[unfurl] analyzeUrl start url=${url}`);

  // Pré-fase 1: tentar resolver diretamente via notioncache (match exato da URL)
  const notionIdentity = tryNotionIdentity(url);
  if (notionIdentity) {
    debugLog("[unfurl] resolved via notion_direct (pre-phase1)");
    return notionIdentity;
  }

  const parsed = new URL(url);
  const domain = parsed.hostname.replace(/^www\./, "");
  const urlSlug = buildSlugFromPath(parsed.pathname);

  const html = await fetchHtml(url);
  const pageTitle = extractTitle(html);
  const ogTitle = extractMetaContent(html, "og:title");
  const ogSite = extractMetaContent(html, "og:site_name");
  const isBlocked = detectBlocked(html.toLowerCase(), pageTitle?.toLowerCase() ?? null);

  debugLog(
    `[unfurl] initial html parsed isBlocked=${isBlocked} pageTitle=${pageTitle ?? ""}`
  );

  let identity: Identity = {
    url,
    domain,
    urlSlug: urlSlug || "—",
    pageTitle,
    ogTitle,
    ogSite,
    isBlocked,
    unfurlVia: "none",
    fallbackLabel: `${domain} · ${urlSlug || "—"}`
  };

  if (isBlocked) {
    debugLog("[unfurl] html detected blocked, entering unfurlBlocked()");
    const meta = await unfurlBlocked(url);

    if (meta) {
      identity = {
        ...identity,
        pageTitle: meta.ogTitle || meta.title || identity.pageTitle,
        ogTitle: meta.ogTitle || identity.ogTitle,
        ogSite: meta.ogSite || identity.ogSite,
        unfurlVia: meta.via
      };
      debugLog(`[unfurl] blocked resolved via=${meta.via}`);
    } else {
      identity = { ...identity, unfurlVia: "fallback" };
      debugLog("[unfurl] blocked unresolved, using fallback");
    }
  } else {
    debugLog("[unfurl] html not blocked, skipping unfurlBlocked()");
  }

  if (
    identity.isBlocked &&
    identity.pageTitle &&
    BLOCKED_PATTERNS.test(identity.pageTitle)
  ) {
    debugLog("[unfurl] pageTitle matched BLOCKED_PATTERNS, clearing pageTitle");
    identity.pageTitle = null;
  }

  // ===== Sugestão de Iframely para UX (não chama a API aqui) =====

  const usage = readIframelyUsage();
  const softLimit = getIframelySoftLimit();

  const shouldSuggestIframely =
    usage.hits >= softLimit &&
    identity.isBlocked &&
    !identity.pageTitle &&
    !identity.ogTitle;

  if (shouldSuggestIframely) {
    (identity as any).iframelySuggestion = "hit";
    debugLog(
      `[unfurl] iframelySuggestion=hit hits=${usage.hits} softLimit=${softLimit} url=${url}`
    );
  }

  debugLog(
    `[unfurl] analyzeUrl done via=${identity.unfurlVia} title=${identity.pageTitle ?? identity.ogTitle ?? ""}`
  );

  return identity;
}
