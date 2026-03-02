// src/embedding/textCanonicalizer.ts (v1.1 - anti-challenge title for identity embeddings)

import type { Identity } from '../domain/identity.js';
import type { NotionPage } from '../domain/snapshot.js';

const CHALLENGE_TITLE_PATTERNS: RegExp[] = [
  /just a moment/i,
  /security checkpoint/i,
  /vercel security checkpoint/i,
  /attention required/i,
  /checking (your )?browser/i,
  /verify (you are )?human/i,
  /human verification/i,
  /bot verification/i,
  /access denied/i,
  /request blocked/i,
  /cloudflare/i,
  /challenge/i,
];

function clean(str: string | null | undefined): string {
  return String(str ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]+\]/g, '')       // remove colchetes tipo [Update]
    .replace(/v?\d+(\.\d+)*\b/gi, '') // remove versões grosseiramente
    .trim();
}

function isChallengeTitle(title: string | null | undefined): boolean {
  const t = clean(title);
  if (!t) return false;
  return CHALLENGE_TITLE_PATTERNS.some((rx) => rx.test(t));
}

export function buildIdentityText(identity: Identity): string {
  const rawBestTitle = identity.pageTitle || identity.ogTitle || '';

  // Se o título parecer challenge/checkpoint, ignora.
  const title = isChallengeTitle(rawBestTitle) ? '' : clean(rawBestTitle);

  const domain = clean(identity.domain);
  const creator = clean(identity.creator ?? '');
  const slug = clean(identity.urlSlug);

  const parts: string[] = [];

  // Em páginas bloqueadas, prioriza sinais estruturais; título só entra se parecer real.
  if (title) parts.push(title);
  if (slug && (!title || slug.toLowerCase() !== title.toLowerCase())) parts.push(slug);
  if (domain) parts.push(`from ${domain}`);
  if (creator) parts.push(`by ${creator}`);

  return parts.join(' • ');
}

export function buildCandidateText(page: NotionPage): string {
  const title = clean(page.title || page.filename || '');
  const creator = clean(page.creator ?? '');
  const url = clean(page.url);

  const parts: string[] = [];
  if (title) parts.push(title);
  if (creator) parts.push(`by ${creator}`);
  if (url) parts.push(url);

  return parts.join(' • ');
}