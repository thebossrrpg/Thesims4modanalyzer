// src/phase1/analyzeUrl.ts
import ogs from "open-graph-scraper";
import fs from "node:fs";
import path from "node:path";
import type { UnfurlVia } from "../domain/identity.js";
type UnfurlMeta = {
  title: string | null;
  ogTitle: string | null;
  ogSite: string | null;
  via: UnfurlVia;
};

type ProviderKey = "ogWebApi" | "localOgs";
const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7"
};
const BLOCKED_PATTERNS = /(just a moment|cloudflare|access denied|checking your browser)/i;
const providerState = {
    ogWebApi: { blockedUntilMs: 0 },
    localOgs: { blockedUntilMs: 0 }
};
function normalizeMeta(
  meta: {
    title?: string | null;
    ogTitle?: string | null;
    ogSite?: string | null;
  },
  via: UnfurlVia
): UnfurlMeta {
  return {
    title: meta.title ?? null,
    ogTitle: meta.ogTitle ?? null,
    ogSite: meta.ogSite ?? null,
    via
  };
}

type CachedUnfurl = {
  meta: UnfurlMeta;
  expiresAtMs: number;
};

const unfurlCache = new Map<string, CachedUnfurl>();
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const IFRAMELY_USAGE_FILE = path.join(CACHE_DIR, "iframely-usage.json");
// ===== Debug helper =====
function debugLog(msg: string): void {
    if (process.env.UNFURL_DEBUG === "1") {
        console.error(msg);
    }
}
function ensureCacheDir() {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    catch {
        // ignore
    }
}
function currentMonthKey(d: Date = new Date()): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}
function readIframelyUsage() {
    ensureCacheDir();
    const month = currentMonthKey();
    try {
        const raw = fs.readFileSync(IFRAMELY_USAGE_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object")
            return { month, hits: 0 };
        if (data.month !== month)
            return { month, hits: 0 };
        return {
            month,
            hits: Number.isFinite(data.hits) ? data.hits : 0,
            cooldownUntilMs: typeof data.cooldownUntilMs === "number"
                ? data.cooldownUntilMs
                : undefined
        };
    }
    catch {
        return { month, hits: 0 };
    }
}
function getIframelySoftLimit() {
    const v = Number(process.env.IFRAMELY_SOFT_LIMIT ?? "700");
    return Number.isFinite(v) && v >= 0 ? v : 700;
}
function nowMs(): number {
    return Date.now();
}
function canTry(provider: "ogWebApi" | "localOgs"): boolean {
    return nowMs() >= providerState[provider].blockedUntilMs;
}
function cooldown(provider: "ogWebApi" | "localOgs", ms: number): void {
    providerState[provider].blockedUntilMs = nowMs() + ms;
}
function buildSlugFromPath(pathname: string): string {
    return pathname
        .replace(/^\/+|\/+$/g, "")
        .replace(/[-/]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Normaliza hash-routing ANTES de qualquer fase.
 *
 * Exemplo:
 *   https://scumbumbomods.com/#/packing-crates/
 *   → https://scumbumbomods.com/packing-crates/
 *
 * Para outros sites, só remove fragmento (#...).
 */
function normalizeHashRouting(raw: string): string {
    try {
        const url = new URL(raw);
        if (url.hash.startsWith("#/")) {
            const hashPath = url.hash.slice(2); // tira "#/"
            url.pathname = "/" + hashPath.replace(/^\/+/, "");
            url.hash = "";
            return url.toString();
        }
        // default: só remove fragmento
        if (url.hash) {
            url.hash = "";
        }
        return url.toString();
    }
    catch {
        return raw;
    }
}
/**
 * 🔒 Normalização determinística de URL para Phase 0 (match com snapshot)
 */
function normalizeUrlForExactMatch(u: string): string {
    const raw = String(u ?? "").trim();
    if (!raw)
        return "";
    // aceita URLs "reais" (com http/https) e também os formatos compactados do snapshot
    // ex: "httpswww.curseforge.comsims4modssim-control-hub"
    const looksLikeCompact = /^httpswww/i.test(raw) && !/^https?:\/\//i.test(raw);
    // Se já parece compact, normaliza minimamente (lowercase + remove espaços) e retorna direto
    // para que "needle" e "p.url" possam cair na mesma representação.
    if (looksLikeCompact) {
        return raw.replace(/\s+/g, "").toLowerCase();
    }
    if (!/^https?:\/\//i.test(raw))
        return raw;
    try {
        // IMPORTANTE: aplicar normalização de hash-routing antes
        const normalized = normalizeHashRouting(raw);
        const parsed = new URL(normalized);
        // protocol: force https
        parsed.protocol = "https:";
        // host normalize
        parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        // path normalize
        parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
        if (parsed.pathname.length > 1) {
            parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
        }
        // query normalize (igual antes)
        const DROP_KEYS = new Set([
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
            "utm_id",
            "utm_name",
            "utm_reader",
            "utm_viz_id",
            "fbclid",
            "gclid",
            "msclkid",
            "yclid",
            "twclid",
            "igshid",
            "ref",
            "ref_src",
            "source"
        ]);
        const kept = Array.from(parsed.searchParams.entries()).filter(([k, v]) => {
            const key = k.toLowerCase().trim();
            if (!key)
                return false;
            if (DROP_KEYS.has(key))
                return false;
            if (key.startsWith("utm_"))
                return false;
            return String(v ?? "").trim().length > 0;
        });
        kept.sort(([a], [b]) => a.localeCompare(b));
        parsed.search = "";
        for (const [k, v] of kept)
            parsed.searchParams.append(k, v);
        const asUrl = parsed.toString();
        // NOVO: representação "compact" para bater com snapshot legado
        // (remove separadores e pontuação; mantém determinismo)
        const compact = asUrl
            .toLowerCase()
            .replace(/^https:\/\//i, "https")
            .replace(/\./g, "")
            .replace(/\//g, "")
            .replace(/\?/g, "")
            .replace(/&/g, "")
            .replace(/=/g, "")
            .replace(/\s+/g, "");
        // Heurística determinística: se a URL do snapshot é compacta, queremos retornar compact.
        // Como aqui não sabemos "qual lado" estamos normalizando, retornamos a forma compact
        // sempre (porque o Phase 0 só precisa de igualdade de string).
        return compact;
    }
    catch {
        return raw;
    }
}
function extractTitle(html: string): string | null {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m)
        return null;
    return m[1].replace(/\s+/g, " ").trim() || null;
}
function extractMetaContent(html: string, key: string): string | null {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const m = html.match(re);
    return m?.[1]?.trim() || null;
}
function detectBlocked(
  htmlLower: string,
  pageTitleLower: string | null
): boolean {
    if (BLOCKED_PATTERNS.test(htmlLower))
        return true;
    if (pageTitleLower && BLOCKED_PATTERNS.test(pageTitleLower))
        return true;
    return false;
}
function isUselessText(s: string | null | undefined): boolean {
    if (!s)
        return true;
    return BLOCKED_PATTERNS.test(s);
}
function isUsefulMeta(
  meta: { title: string | null; ogTitle: string | null; ogSite: string | null }
): boolean {
  const best = meta.ogTitle || meta.title || null;

  if (!best) return false;
  if (isUselessText(best)) return false;

  return true;
}
async function fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: REQUEST_HEADERS,
            redirect: "follow",
            signal: controller.signal
        });
        return (await res.text()) || "";
    }
    catch {
        return "";
    }
    finally {
        clearTimeout(timeout);
    }
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

function setCachedUnfurl(
  url: string,
  meta: UnfurlMeta,
  ttlMs: number
): void {
  unfurlCache.set(url, {
    meta,
    expiresAtMs: nowMs() + ttlMs
  });
}
let snapshotLoaded = false;
let snapshotPages: Record<string, any> | null = null;
function loadSnapshotPages() {
    if (snapshotLoaded)
        return;
    snapshotLoaded = true;
    try {
        const raw = fs.readFileSync(path.resolve(process.cwd(), "snapshot.json"), "utf-8");
        const snap = JSON.parse(raw);
        snapshotPages = snap.notion_pages ?? snap.phase_2_cache?.pages ?? null;
        if (snapshotPages) {
            debugLog(`[unfurl] snapshot loaded pages=${Object.keys(snapshotPages).length}`);
        }
    }
    catch {
        snapshotPages = null;
    }
}
import type { Identity } from "../domain/identity.js";

function tryNotionIdentity(url: string): Identity | null {
    loadSnapshotPages();
    if (!snapshotPages)
        return null;
    // aplica a mesma normalização (incluindo hash-routing)
    const needle = normalizeUrlForExactMatch(url);
    if (!needle)
        return null;
    const match = Object.values(snapshotPages as Record<string, { url?: string; filename?: string }>).find(
  (p) => {
        if (!p?.url)
            return false;
        const pNorm = normalizeUrlForExactMatch(p.url);
        return pNorm === needle;
    });
    if (!match || !match.url)
        return null;
    // ✅ FIX: usa URL original (válida para new URL()), não a compactada
    const finalUrl = match.url;
    const parsed = new URL(finalUrl);
    const domain = parsed.hostname.replace(/^www\./, "");
    const urlSlug = buildSlugFromPath(parsed.pathname);
    const title = match.filename?.trim() || null;
    return {
        url: finalUrl,
        domain,
        urlSlug: urlSlug || "—",
        pageTitle: title,
        ogTitle: title,
        ogSite: "Snapshot",
        isBlocked: false,
        unfurlVia: "notion_direct",
        fallbackLabel: `${domain} · ${urlSlug || "—"}`
    };
}
// ===== Providers (Phase 1) =====
async function tryOgWebApi(url: string): Promise<UnfurlMeta | null> {
    const res = await fetch(`https://og-web-scraper-api.vercel.app/scrape?url=${encodeURIComponent(url)}`);
    if (!res.ok)
        return null;
    const data = await res.json();
    const title = data?.ogTitle ?? data?.title ?? null;
    const ogSite = data?.ogSiteName ?? null;
    const meta = normalizeMeta({ title, ogTitle: title, ogSite }, "og_web_scraper");
    return isUsefulMeta(meta) ? meta : null;
}
async function tryLocalOgs(url: string): Promise<UnfurlMeta | null> {
  const result = await ogs({
    url,
    timeout: 8000,
    onlyGetOpenGraphInfo: true,
    fetchOptions: { headers: REQUEST_HEADERS }
  });

  const r = result?.result;
  if (!r) return null;

  const meta = normalizeMeta(
    {
      title: r.ogTitle ?? null,
      ogTitle: r.ogTitle ?? null,
      ogSite: r.ogSiteName ?? null
    },
    "local_ogs"
  );

  return isUsefulMeta(meta) ? meta : null;
}
async function unfurlBlocked(url: string): Promise<UnfurlMeta | null> {
  const cached = getCachedUnfurl(url);
  if (cached) return cached;

  if (canTry("ogWebApi")) {
    const meta = await tryOgWebApi(url);
    if (meta) {
      setCachedUnfurl(url, meta, 6 * 60 * 60_000);
      return meta;
    }
    cooldown("ogWebApi", 5 * 60_000);
  }

  if (canTry("localOgs")) {
    const meta = await tryLocalOgs(url);
    if (meta) {
      setCachedUnfurl(url, meta, 6 * 60 * 60_000);
      return meta;
    }
    cooldown("localOgs", 2 * 60_000);
  }

  return null;
}

export async function analyzeUrl(url: string): Promise<Identity> {

    // Normaliza hash-routing logo no início
    const normalizedUrl = normalizeHashRouting(url);
    // ===== Phase 0 =====
    const direct = tryNotionIdentity(normalizedUrl);
    if (direct)
        return direct;
    // ===== Phase 1 =====
    const parsed = new URL(normalizedUrl);
    const domain = parsed.hostname.replace(/^www\./, "");
    const urlSlug = buildSlugFromPath(parsed.pathname);
    const html = await fetchHtml(normalizedUrl);
    const pageTitle = extractTitle(html);
    const titleLower = pageTitle?.toLowerCase() ?? '';

    const isHard404 =
      titleLower.includes('404') ||
      titleLower.includes('page not found') ||
      titleLower.includes('not found');
  
    console.log('DEBUG 404 CHECK:', titleLower);
    console.log('isHard404 =', isHard404);

    if (isHard404) {
      throw new Error('A URL informada não retornou uma página válida.');
    }

    const ogTitle = extractMetaContent(html, "og:title");
    const ogSite = extractMetaContent(html, "og:site_name");
    const isBlocked = detectBlocked(html.toLowerCase(), pageTitle?.toLowerCase() ?? null);
    let identity: Identity = {
        url: normalizedUrl,
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
        const meta = await unfurlBlocked(normalizedUrl);
        if (meta) {
            identity = {
                ...identity,
                pageTitle: meta.ogTitle ?? meta.title ?? identity.pageTitle,
                ogTitle: meta.ogTitle ?? identity.ogTitle,
                ogSite: meta.ogSite ?? identity.ogSite,
                unfurlVia: meta.via
            };
        }
        else {
            identity.unfurlVia = "fallback";
        }
    }
    return identity;
}
