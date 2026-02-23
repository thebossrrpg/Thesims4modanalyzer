// src/phase1/analyzeUrl.ts — v1.3.0
// ✅ Fixes aplicados:
// 1. BLOCKED_PATTERNS robusto (scumbumbo, cf-challenge, etc.)
// 2. detectBlocked() com heurística tamanho + conteúdo
// 3. tryIframely() sempre se title suspeito (SCUMBUMBO-like)
// 4. Debug logs [Phase 1] Raw + isBlocked
// 5. tryLocalOgs() / tryOgWebApi() com try/catch
// 6. isSuspiciousTitle() para forçar unfurl
import 'dotenv/config';
import ogs from "open-graph-scraper";
import fs from "node:fs";
import path from "node:path";
const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7"
};
// ✅ CORRETO — tudo em UMA linha
const BLOCKED_PATTERNS = /just a moment|cloudflare|access denied|checking your browser|challenge-platform|cf-browser-verification|cf-chl|js-challenge|scumbumbo/i;
const providerState = {
    ogWebApi: { blockedUntilMs: 0 },
    localOgs: { blockedUntilMs: 0 },
    openGraphXyz: { blockedUntilMs: 0 },
    iframely: { blockedUntilMs: 0 },
    microlink: { blockedUntilMs: 0 }
};
function normalizeMeta(meta, via) {
    return {
        title: meta.title ?? null,
        ogTitle: meta.ogTitle ?? null,
        ogSite: meta.ogSite ?? null,
        via
    };
}
const unfurlCache = new Map();
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const IFRAMELY_USAGE_FILE = path.join(CACHE_DIR, "iframely-usage.json");
// ===== Debug helper =====
function debugLog(msg) {
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
function currentMonthKey(d = new Date()) {
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
function nowMs() {
    return Date.now();
}
function canTry(provider) {
    return nowMs() >= providerState[provider].blockedUntilMs;
}
function cooldown(provider, ms) {
    providerState[provider].blockedUntilMs = nowMs() + ms;
}
function buildSlugFromPath(pathname) {
    return pathname
        .replace(/^\/+|\/+$/g, "")
        .replace(/[-/]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Normaliza hash-routing ANTES de qualquer fase.
 */
function normalizeHashRouting(raw) {
    try {
        const url = new URL(raw);
        if (url.hash.startsWith("#/")) {
            const hashPath = url.hash.slice(2);
            url.pathname = "/" + hashPath.replace(/^\/+/, "");
            url.hash = "";
            return url.toString();
        }
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
 * 🔒 Normalização determinística de URL para Phase 0
 */
function normalizeUrlForExactMatch(u) {
    const raw = String(u ?? "").trim();
    if (!raw)
        return "";
    const looksLikeCompact = /^httpswww/i.test(raw) && !/^https?:\/\//i.test(raw);
    if (looksLikeCompact) {
        return raw.replace(/\s+/g, "").toLowerCase();
    }
    if (!/^https?:\/\//i.test(raw))
        return raw;
    try {
        const normalized = normalizeHashRouting(raw);
        const parsed = new URL(normalized);
        parsed.protocol = "https:";
        parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
        if (parsed.pathname.length > 1) {
            parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
        }
        const DROP_KEYS = new Set([
            "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
            "utm_id", "utm_name", "utm_reader", "utm_viz_id", "fbclid", "gclid",
            "msclkid", "yclid", "twclid", "igshid", "ref", "ref_src", "source"
        ]);
        const kept = Array.from(parsed.searchParams.entries()).filter(([k, v]) => {
            const key = k.toLowerCase().trim();
            if (!key || DROP_KEYS.has(key) || key.startsWith("utm_"))
                return false;
            return String(v ?? "").trim().length > 0;
        });
        kept.sort(([a], [b]) => a.localeCompare(b));
        parsed.search = "";
        for (const [k, v] of kept)
            parsed.searchParams.append(k, v);
        const asUrl = parsed.toString();
        const compact = asUrl
            .toLowerCase()
            .replace(/^https:\/\//i, "https")
            .replace(/\./g, "")
            .replace(/\//g, "")
            .replace(/\?/g, "")
            .replace(/&/g, "")
            .replace(/=/g, "")
            .replace(/\s+/g, "");
        return compact;
    }
    catch {
        return raw;
    }
}
function extractTitle(html) {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m)
        return null;
    return m[1].replace(/\s+/g, " ").trim() || null;
}
function extractMetaContent(html, key) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const m = html.match(re);
    return m?.[1]?.trim() || null;
}
// 🔧 ROBUSTO — heurística tamanho + padrões modernos
function detectBlocked(htmlLower, pageTitleLower) {
    // Padrões regex
    if (BLOCKED_PATTERNS.test(htmlLower) ||
        (pageTitleLower && BLOCKED_PATTERNS.test(pageTitleLower))) {
        return true;
    }
    // 🔧 NOVO: heurística tamanho + conteúdo suspeito
    if (htmlLower.length < 5000 || // HTML muito curto (bloqueio)
        (htmlLower.includes('scumbumbo') && pageTitleLower?.match(/^[A-Z]+$/))) { // SCUMBUMBO pattern
        return true;
    }
    return false;
}
function isUselessText(s) {
    if (!s)
        return true;
    return BLOCKED_PATTERNS.test(s);
}
// 🔧 NOVO — detecta títulos suspeitos (SCUMBUMBO-like)
function isSuspiciousTitle(title) {
    if (!title)
        return true;
    const upper = title.toUpperCase();
    return /^[A-Z\s!@#$%^&*()]+$/.test(upper) ||
        title.length < 10 ||
        !!title.match(/^[A-Z]{3,}$/);
}
function isUsefulMeta(meta) {
    const best = meta.ogTitle || meta.title || null;
    if (!best)
        return false;
    if (isUselessText(best))
        return false;
    return true;
}
async function fetchHtml(url) {
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
function getCachedUnfurl(url) {
    const entry = unfurlCache.get(url);
    if (!entry)
        return null;
    if (nowMs() > entry.expiresAtMs) {
        unfurlCache.delete(url);
        return null;
    }
    return entry.meta;
}
function setCachedUnfurl(url, meta, ttlMs) {
    unfurlCache.set(url, {
        meta,
        expiresAtMs: nowMs() + ttlMs
    });
}
let snapshotLoaded = false;
let snapshotPages = null;
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
function tryNotionIdentity(url) {
    loadSnapshotPages();
    if (!snapshotPages)
        return null;
    const needle = normalizeUrlForExactMatch(url);
    if (!needle)
        return null;
    const match = Object.values(snapshotPages).find((p) => {
        if (!p?.url)
            return false;
        const pNorm = normalizeUrlForExactMatch(p.url);
        return pNorm === needle;
    });
    if (!match || !match.url)
        return null;
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
// ===== Providers (Phase 1) — com try/catch =====
async function tryOgWebApi(url) {
    try {
        const res = await fetch(`https://og-web-scraper-api.vercel.app/scrape?url=${encodeURIComponent(url)}`);
        if (!res.ok)
            return null;
        const data = await res.json();
        const title = data?.ogTitle ?? data?.title ?? null;
        const ogSite = data?.ogSiteName ?? null;
        const meta = normalizeMeta({ title, ogTitle: title, ogSite }, "og_web_scraper");
        return isUsefulMeta(meta) ? meta : null;
    }
    catch {
        return null;
    }
}
async function tryLocalOgs(url) {
    try {
        const result = await ogs({
            url,
            timeout: 8000,
            onlyGetOpenGraphInfo: true,
            fetchOptions: { headers: REQUEST_HEADERS }
        });
        const r = result?.result;
        if (!r)
            return null;
        const meta = normalizeMeta({
            title: r.ogTitle ?? null,
            ogTitle: r.ogTitle ?? null,
            ogSite: r.ogSiteName ?? null
        }, "local_ogs");
        return isUsefulMeta(meta) ? meta : null;
    }
    catch {
        return null;
    }
}
// ✅ NOVO — OpenGraph.xyz (entre LocalOgs e Iframely)
async function tryOpenGraphXyz(url) {
    try {
        const ogUrl = `https://www.opengraph.xyz/url/${encodeURIComponent(url)}`;
        const html = await fetchHtml(ogUrl);
        if (!html)
            return null;
        const title = extractMetaContent(html, "og:title") ?? extractTitle(html);
        const ogSite = extractMetaContent(html, "og:site_name") ?? null;
        const meta = normalizeMeta({
            title,
            ogTitle: title,
            ogSite
        }, "fallback");
        return isUsefulMeta(meta) ? meta : null;
    }
    catch {
        return null;
    }
}
// src/phase1/analyzeUrl.ts — tryIframely (COM API KEY)
async function tryIframely(url) {
    try {
        const apiKey = String(process.env.IFRAMELY_API_KEY ?? "").trim();
        if (!apiKey)
            return null;
        const res = await fetch(`https://iframely.io/?url=${encodeURIComponent(url)}&api_key=${encodeURIComponent(apiKey)}`);
        if (!res.ok) {
            console.log(`❌ Iframely ${res.status}`);
            return null;
        }
        const data = await res.json();
        console.log('🔍 Iframely raw:', JSON.stringify(data, null, 2).slice(0, 200));
        const meta = normalizeMeta({
            title: data.title ?? data.meta?.title ?? null,
            ogTitle: data.meta?.og?.title ?? null,
            ogSite: data.meta?.og?.site_name ?? data.meta?.publisher ?? null
        }, "iframely");
        return isUsefulMeta(meta) ? meta : null;
    }
    catch (e) {
        console.log('❌ Iframely erro:', e);
        return null;
    }
}
// ✅ NOVO — Microlink (depois do Iframely)
// Integração via parâmetros meta.* (conforme docs)
async function tryMicrolink(url) {
    try {
        const base = "https://api.microlink.io/";
        const params = new URLSearchParams();
        params.set("url", url);
        // meta via parâmetros (docs): pede só o que a gente usa
        params.set("meta.title", "true");
        params.set("meta.publisher", "true");
        // opcional: endpoint proxy (para plano/API key), se você usar isso
        const endpoint = String(process.env.MICROLINK_ENDPOINT ?? "").trim();
        if (endpoint)
            params.set("endpoint", endpoint);
        const res = await fetch(`${base}?${params.toString()}`, {
            method: "GET",
            headers: REQUEST_HEADERS
        });
        if (!res.ok)
            return null;
        const json = await res.json();
        const data = json?.data ?? null;
        const title = data?.title ?? null;
        const ogSite = data?.publisher ?? null;
        const meta = normalizeMeta({
            title,
            ogTitle: title,
            ogSite
        }, "fallback");
        return isUsefulMeta(meta) ? meta : null;
    }
    catch {
        return null;
    }
}
async function unfurlBlocked(url) {
    const cached = getCachedUnfurl(url);
    if (cached)
        return cached;
    // Ordem pedida:
    // 1) OgWebApi → 2) LocalOgs → 3) OpenGraph.xyz → 4) Iframely (com API key) → 5) Microlink
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
    if (canTry("openGraphXyz")) {
        const meta = await tryOpenGraphXyz(url);
        if (meta) {
            setCachedUnfurl(url, meta, 6 * 60 * 60_000);
            return meta;
        }
        cooldown("openGraphXyz", 2 * 60_000);
    }
    if (canTry("iframely")) {
        const meta = await tryIframely(url);
        if (meta) {
            setCachedUnfurl(url, meta, 6 * 60 * 60_000);
            return meta;
        }
        cooldown("iframely", 1 * 60_000);
    }
    if (canTry("microlink")) {
        const meta = await tryMicrolink(url);
        if (meta) {
            setCachedUnfurl(url, meta, 6 * 60 * 60_000);
            return meta;
        }
        cooldown("microlink", 1 * 60_000);
    }
    return null;
}
export async function analyzeUrl(url) {
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
    // 🔧 DEBUG — sempre loga raw
    console.log('🧪 [Phase 1] Raw:', {
        pageTitle: pageTitle?.slice(0, 50),
        ogTitle: extractMetaContent(html, "og:title")?.slice(0, 50),
        htmlLength: html.length,
        domain
    });
    const isHard404 = titleLower.includes('404') ||
        titleLower.includes('page not found') ||
        titleLower.includes('not found');
    console.log('DEBUG 404 CHECK:', titleLower);
    console.log('isHard404 =', isHard404);
    if (isHard404) {
        throw new Error('A URL informada não retornou uma página válida.');
    }
    const ogTitle = extractMetaContent(html, "og:title");
    const ogSite = extractMetaContent(html, "og:site_name");
    const htmlLower = html.toLowerCase();
    const pageTitleLower = pageTitle?.toLowerCase() ?? null;
    const isBlocked = detectBlocked(htmlLower, pageTitleLower);
    console.log('🧪 [Phase 1] Blocked?', isBlocked);
    let identity = {
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
    // 🔧 SEMPRE tenta unfurl se blocked OU título suspeito
    if (isBlocked || isSuspiciousTitle(pageTitle)) {
        console.log('🤖 [Phase 1] Tentando unfurlBlocked()...');
        const meta = await unfurlBlocked(normalizedUrl);
        if (meta) {
            identity = {
                ...identity,
                pageTitle: meta.ogTitle ?? meta.title ?? identity.pageTitle,
                ogTitle: meta.ogTitle ?? identity.ogTitle,
                ogSite: meta.ogSite ?? identity.ogSite,
                unfurlVia: meta.via,
                isBlocked: false // Unfurl "desbloqueou"
            };
            console.log('✅ [Phase 1] Unfurl sucesso:', identity.pageTitle?.slice(0, 50));
        }
        else {
            identity.unfurlVia = "fallback";
            console.log('❌ [Phase 1] Unfurl falhou, usando raw');
        }
    }
    return identity;
}
