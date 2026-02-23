// src/embedding/textCanonicalizer.ts
import type { Identity } from '../domain/identity.js';
import type { NotionPage } from '../domain/snapshot.js';

function clean(str: string | null | undefined): string {
  return String(str ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]+\]/g, '')       // remove colchetes tipo [Update]
    .replace(/v?\d+(\.\d+)*\b/gi, '') // remove versões grosseiramente
    .trim();
}

export function buildIdentityText(identity: Identity): string {
  const title = clean(identity.pageTitle || identity.ogTitle || '');
  const domain = clean(identity.domain);
  const creator = clean(identity.creator ?? '');
  const slug = clean(identity.urlSlug);

  const parts: string[] = [];
  if (title) parts.push(title);
  if (slug && slug.toLowerCase() !== title.toLowerCase()) parts.push(slug);
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
