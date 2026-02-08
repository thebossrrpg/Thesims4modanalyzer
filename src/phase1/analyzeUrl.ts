import ogs from "open-graph-scraper";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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

type ProviderKey = "ogWebApi" | "localOgs" | "iframely";
type ProviderState = { blockedUntilMs: number };

const providerState: Record<ProviderKey, ProviderState> = {
  ogWebApi: { blockedUntilMs: 0 },
  localOgs: { blockedUntilMs: 0 },
  iframely: { blockedUntilMs: 0 }
};

type CacheEntry = { expiresAtMs: number; meta: UnfurlMeta };
const unfurlCache = new Map<string, CacheEntry>();

// ===== Iframely usage persistence =====

type IframelyUsage = {
  month: string; // YYYY-MM
  hits: number;
  cooldownUntilMs?: number;
};

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const IFRAMELY_USAGE_FILE = path.join(CACHE_DIR, "iframely-usage.json");

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

function writeIframelyUsage(usage: IframelyUsage): void {
  ensureCacheDir();
  try {
    fs.writeFileSync(IFRAMELY_USAGE_FILE, JSON.stringify(usage, null, 2), "utf-8");
  } catch {
    // ignore
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
    const res = await fetch(url, {
      method: "GET",
      headers: REQUEST_HEADERS,
      redirect: "follow",
      signal: controller.signal
    });

    const text = await res.text();
    return text || "";
  } catch {
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

// ===== Providers =====

// 1) FREE: og-web-scraper-api.vercel.app
async function tryOgWebApi(url: string): Promise<UnfurlMeta | null> {
  const endpoint = `https://og-web-scraper-api.vercel.app/scrape?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { method: "GET" });

  if (!res.ok) {
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
  if (!isUsefulMeta(meta)) return null;
  return meta;
}

// 2) FREE: open-graph-scraper local
async function tryLocalOgs(url: string): Promise<UnfurlMeta | null> {
  const result = await ogs({
    url,
    timeout: 8000,
    onlyGetOpenGraphInfo: true,
    fetchOptions: { headers: REQUEST_HEADERS } // <- importante
  });

  const r: any = result?.result ?? null;
  if (!r) return null;

  const meta = normalizeMeta(
    {
      title: typeof r.title === "string" ? r.title : null,
      ogTitle: typeof r.ogTitle === "string" ? r.ogTitle : null,
      ogSite: typeof r.ogSiteName === "string" ? r.ogSiteName : null
    },
    "local_ogs"
  );

  if (!isUsefulMeta(meta)) return null;
  return meta;
}

async function askUser(question: string): Promise<"hit" | "skip" | "cooldown"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `${question}\nResponda: hit | skip | cooldown\n> `;

  const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();

  const a = answer.trim().toLowerCase();
  if (a === "hit" || a === "skip" || a === "cooldown") return a;
  return "skip";
}

// 3) LIMITED: Iframely (interactive guard)
async function tryIframelyWithGuard(url: string): Promise<UnfurlMeta | null> {
  const policyRaw = (process.env.IFRAMELY_POLICY || "").trim().toLowerCase();
  const policy =
    policyRaw === "hit" || policyRaw === "skip" || policyRaw === "cooldown"
      ? (policyRaw as "hit" | "skip" | "cooldown")
      : null;

  const apiKey = process.env.IFRAMELY_API_KEY;
  if (!apiKey) return null;

  const usage = readIframelyUsage();

  if (usage.cooldownUntilMs && nowMs() < usage.cooldownUntilMs) {
    return null;
  }

  const softLimit = getIframelySoftLimit();

  if (usage.hits >= softLimit) {
    let answer: "hit" | "skip" | "cooldown";

    if (policy) {
      answer = policy;
    } else if (!process.stdin.isTTY) {
      answer = "skip";
    } else {
      answer = await askUser(
        `Iframely já usou ${usage.hits} hits neste mês (soft limit: ${softLimit}). Deseja aplicar a API ou pular essa etapa?`
      );
    }

    if (answer === "skip") return null;

    if (answer === "cooldown") {
      usage.cooldownUntilMs = nowMs() + 30 * 60_000; // 30 minutos
      writeIframelyUsage(usage);
      return null;
    }
  }

  const endpoint =
    "https://iframe.ly/api/iframely?url=" +
    encodeURIComponent(url) +
    "&api_key=" +
    encodeURIComponent(apiKey);

  const res = await fetch(endpoint, { method: "GET" });

  if (!res.ok) {
    if (res.status === 429) {
      usage.cooldownUntilMs = nowMs() + 60 * 60_000;
      writeIframelyUsage(usage);
      throw new Error("IFRAMELY_RATE_LIMIT");
    }
    if (res.status === 403) {
      usage.cooldownUntilMs = nowMs() + 60 * 60_000;
      writeIframelyUsage(usage);
      throw new Error("IFRAMELY_FORBIDDEN");
    }
    return null;
  }

  const data: any = await res.json();

  const title = typeof data?.meta?.title === "string" ? data.meta.title : null;
  const site = typeof data?.meta?.site === "string" ? data.meta.site : null;

  const meta = normalizeMeta({ title, ogTitle: title, ogSite: site }, "iframely");
  if (!isUsefulMeta(meta)) return null;

  usage.hits += 1;
  writeIframelyUsage(usage);

  return meta;
}

async function unfurlBlocked(url: string): Promise<UnfurlMeta | null> {
  const cached = getCachedUnfurl(url);
  if (cached) return cached;

  const GOOD_TTL = 6 * 60 * 60_000;

  if (canTry("ogWebApi")) {
    try {
      const meta = await tryOgWebApi(url);
      if (meta) {
        setCachedUnfurl(url, meta, GOOD_TTL);
        return meta;
      }
      cooldown("ogWebApi", 5 * 60_000);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      cooldown("ogWebApi", msg.includes("RATE_LIMIT") ? 30 * 60_000 : 10 * 60_000);
    }
  }

  if (canTry("localOgs")) {
    try {
      const meta = await tryLocalOgs(url);
      if (meta) {
        setCachedUnfurl(url, meta, GOOD_TTL);
        return meta;
      }
      cooldown("localOgs", 2 * 60_000);
    } catch {
      cooldown("localOgs", 2 * 60_000);
    }
  }

  if (canTry("iframely")) {
    try {
      const meta = await tryIframelyWithGuard(url);
      if (meta) {
        setCachedUnfurl(url, meta, GOOD_TTL);
        return meta;
      }
      cooldown("iframely", 10 * 60_000);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      cooldown("iframely", msg.includes("RATE_LIMIT") ? 60 * 60_000 : 15 * 60_000);
    }
  }

  return null;
}

export async function analyzeUrl(url: string): Promise<Identity> {
  const parsed = new URL(url);
  const domain = parsed.hostname.replace(/^www\./, "");
  const urlSlug = buildSlugFromPath(parsed.pathname);

  const html = await fetchHtml(url);
  const pageTitle = extractTitle(html);
  const ogTitle = extractMetaContent(html, "og:title");
  const ogSite = extractMetaContent(html, "og:site_name");
  const isBlocked = detectBlocked(html.toLowerCase(), pageTitle?.toLowerCase() ?? null);

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
    const meta = await unfurlBlocked(url);

    if (meta) {
      identity = {
        ...identity,
        pageTitle: meta.ogTitle || meta.title || identity.pageTitle,
        ogTitle: meta.ogTitle || identity.ogTitle,
        ogSite: meta.ogSite || identity.ogSite,
        unfurlVia: meta.via
      };
    } else {
      identity = { ...identity, unfurlVia: "fallback" };
    }
  }

if (identity.isBlocked && identity.pageTitle && BLOCKED_PATTERNS.test(identity.pageTitle)) {
  identity.pageTitle = null;
}

  return identity;
}
