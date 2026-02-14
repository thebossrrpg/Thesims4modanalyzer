// src/main.ts (v1.0.2 - com helper getNotionPageUrl)
import { analyzeUrl } from './phase1/analyzeUrl.js';
import { searchNotionCache } from './phase2/searchNotionCache.js';
import { getNotionPageUrl } from './utils/notion.js';
import type { NotionCacheSnapshot } from './domain/snapshot.js';
import type { Identity } from './domain/identity.js';
import type { Decision } from './domain/decision.js';
import fs from 'fs';

const rawArgs = process.argv.slice(2);
const inputUrl = rawArgs.find(a => !a.startsWith('--'));
const flagJson = rawArgs.includes('--json');

if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
  console.error('❌ Erro: informe uma URL válida.');
  console.error('Uso: node dist/src/main.js <url> [--json]');
  process.exit(1);
}

const startedAt = new Date().toISOString();

interface FinalResult {
  createdAt: string;
  inputUrl: string;
  identity: Identity;
  decision: Decision;
  phase: {
    phase1: { ok: boolean };
    phase2: { ran: boolean; candidates: number };
    phase25: { ran: boolean; urlDiverge: boolean };
    phase3: { ran: boolean };
  };
  candidates: NotionPageWithScore[];
}

interface NotionPageWithScore {
  notionid: string;          // ✅ camelCase (bate com phase2)
  url: string;
  title: string | null;
  filename: string | null;
  creator: string | null;
  createdtime: string;       // ✅ camelCase
  lasteditedtime: string;    // ✅ camelCase
  _score?: number;
  _reasons?: string[];
}

try {
  // ═══════════════════════════════════════════════════════
  // PHASE 0: URL lookup no snapshot (SEMPRE PRIMEIRO!)
  // ═══════════════════════════════════════════════════════
  const snapshot = loadSnapshot('./snapshot.json');

  const inputKeys = urlLookupKeys(inputUrl);

  console.log('🔍 DEBUG Phase 0:');
  console.log('  Input keys:', inputKeys.slice(0, 8));
  console.log('  Looking for URL match in snapshot...');

  const notionPage = Object.values(snapshot.notion_pages ?? {}).find((p: any) => {
    const pUrl = String((p as any).url ?? '');
    const pKeys = urlLookupKeys(pUrl);
    return pKeys.some(k => inputKeys.includes(k));
  }) as any;

  let final: FinalResult;

  if (notionPage) {
    const notionPageUrlFormatted = getNotionPageUrl(
      notionPage.notion_id,
      notionPage.title ?? notionPage.filename
    );

    final = {
      createdAt: startedAt,
      inputUrl,
      identity: {
        url: inputUrl,
        domain: 'unknown',
        urlSlug: '',
        pageTitle: notionPage.title ?? null,
        ogTitle: null,
        ogSite: null,
        isBlocked: false,
        unfurlVia: 'phase0_direct' as any,
        fallbackLabel: notionPage.title ?? notionPage.filename ?? inputUrl,
      },
      decision: {
        result: 'FOUND',
        phaseResolved: 'PHASE_2',
        reason: 'Direct URL match in Notion snapshot (Phase 0 pre-check)',
        notionId: notionPage.notion_Id,
        notionUrl: notionPageUrlFormatted,
        displayName: notionPage.title ?? notionPage.filename ?? notionPage.url,
        phase2Candidates: 1,
        urlDiverge: false,
      },
      phase: {
        phase1: { ok: false },
        phase2: { ran: false, candidates: 1 },
        phase25: { ran: false, urlDiverge: false },
        phase3: { ran: false },
      },
      candidates: [],
    };

    if (flagJson) {
      console.log(JSON.stringify(final, null, 2));
    } else {
      printHumanSummary(final);
    }
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 1: Extração de identidade (só se Phase 0 falhar)
  // ═══════════════════════════════════════════════════════
  const identity = await analyzeUrl(inputUrl);

  final = {
    createdAt: startedAt,
    inputUrl,
    identity,
    decision: {
      result: 'NOT_FOUND',
      phaseResolved: 'PHASE_2',
      reason: 'Pipeline incompleto',
    },
    phase: {
      phase1: { ok: true },
      phase2: { ran: false, candidates: 0 },
      phase25: { ran: false, urlDiverge: false },
      phase3: { ran: false },
    },
    candidates: [],
  };

  // ═══════════════════════════════════════════════════════
  // PHASE 2: Busca fuzzy no cache Notion
  // ═══════════════════════════════════════════════════════
  const phase2Result = await searchNotionCache(identity, snapshot.phase_2_cache.pages);

  final.decision = phase2Result.decision;
  final.phase.phase2 = {
    ran: true,
    candidates: phase2Result.candidates?.length ?? 0,
  };
  final.candidates = (phase2Result.candidates ?? []) as NotionPageWithScore[];

  // ═══════════════════════════════════════════════════════
  // PHASE 2.5: Check URL diverge (só se FOUND)
  // ═══════════════════════════════════════════════════════
  if (final.decision.result === 'FOUND' && final.decision.notionId) {
    final.phase.phase25.ran = true;

    const notionPage2 = Object.values(snapshot.notion_pages ?? {}).find(
      (p: any) => p.notion_id === final.decision.notionId
    ) as any;

    if (notionPage2?.url) {
      const urlDiverge =
        normalizeUrlForSnapshot(identity.url) !== normalizeUrlForSnapshot(String(notionPage2.url));

      final.phase.phase25.urlDiverge = Boolean(urlDiverge);

      if (urlDiverge) {
        final.decision.reason += ` | ⚠️ URL diverge: input=${identity.url} → real=${notionPage2.url}`;
        final.decision.urlDiverge = true;
        final.decision.notionUrl = getNotionPageUrl(
          notionPage2.notion_id,
          notionPage2.title ?? notionPage2.filename
        );
      } else {
        // URL não diverge, mas garante que notionUrl está formatada
        final.decision.notionUrl = getNotionPageUrl(
          notionPage2.notion_id,
          notionPage2.title ?? notionPage2.filename
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Saída
  // ═══════════════════════════════════════════════════════
  if (flagJson) {
    console.log(JSON.stringify(final, null, 2));
  } else {
    printHumanSummary(final);
  }

} catch (err) {
  console.error('\n❌ Erro fatal:');
  console.error(err);
  process.exit(1);
}

function loadSnapshot(path: string): NotionCacheSnapshot {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Erro ao carregar snapshot de ${path}:`, err);
    throw err;
  }
}

/**
 * Normaliza URL para lookup canônico (para comparação "normal").
 * - Trata hash routing "#/slug" como path "/slug"
 * - Remove fragmento em outros casos
 */
function normalizeUrlForSnapshot(rawUrl: string): string {
  const url = new URL(rawUrl);

  if (url.hash.startsWith('#/')) {
    const hashPath = url.hash.slice(2); // remove "#/"
    url.pathname = '/' + hashPath.replace(/^\/+/, '');
  }
  url.hash = '';
  return url.toString();
}

/**
 * Gera chaves determinísticas (múltiplas) para bater em snapshots que armazenam URL "compactado"
 * Ex.: "httpswww.curseforge.comsims4modssim-control-hub"
 */
function urlLookupKeys(rawUrl: string): string[] {
  if (!rawUrl) return [];

  let canonical = rawUrl.trim();
  try {
    canonical = normalizeUrlForSnapshot(canonical);
  } catch {
    // snapshot pode ter lixo; só retorna variantes do raw mesmo
  }

  const noScheme = canonical.replace(/^https?:\/\//i, '');
  const compact = noScheme.replace(/[./]/g, '');
  const compactNoWww = noScheme.replace(/^www\./i, '').replace(/[./]/g, '');

  // também tenta sem trailing slash
  const canonicalNoSlash = canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
  const noSchemeNoSlash = canonicalNoSlash.replace(/^https?:\/\//i, '');
  const compactNoSlash = noSchemeNoSlash.replace(/[./]/g, '');
  const compactNoWwwNoSlash = noSchemeNoSlash.replace(/^www\./i, '').replace(/[./]/g, '');

  return Array.from(new Set([
    canonical,
    canonicalNoSlash,
    noScheme,
    noSchemeNoSlash,
    compact,
    compactNoWww,
    compactNoSlash,
    compactNoWwwNoSlash,
  ]));
}

/**
 * UX "humana" da CLI
 */
function printHumanSummary(final: FinalResult): void {
  const { identity, decision, candidates } = final;

  const title =
    identity.pageTitle ??
    identity.ogTitle ??
    identity.fallbackLabel ??
    `${identity.domain} · ${identity.urlSlug}`;

  console.log(`\n📦 ${title}`);
  console.log(`🔗 ${identity.url}`);

  if (decision.result === 'FOUND') {
    console.log('\n✅ Match encontrado no Notion.');
    if (decision.displayName) console.log(`   Nome: ${decision.displayName}`);
    if (decision.notionUrl) console.log(`   🔗 Notion: ${decision.notionUrl}`);
    if (decision.urlDiverge) console.log('   ⚠️  URL diverge detectada!');
    if (decision.reason) console.log(`   Motivo: ${decision.reason}`);
  } else {
    console.log('\nℹ️ Não foi possível encontrar um match no Notion.');
    console.log('⚠️ Phase 3 (fallback com IA) ainda não implementada.');
  }

  if (candidates.length > 0) {
    console.log(`\n📋 Candidatos (até 5):`);
    candidates.slice(0, 5).forEach((c, i) => {
      const score = ((c._score || 0) * 100).toFixed(0);
      const reasons = c._reasons?.join(', ') || 'N/A';
      console.log(`  ${i + 1}. "${c.title}"`);
      console.log(`     Score: ${score}% | Razões: ${reasons}`);
      console.log(`     URL: ${c.url}\n`);
    });
  }

  console.log('');
}
