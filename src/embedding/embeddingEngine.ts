// src/embedding/embeddingEngine.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-ignore – no bundle final você ajusta typings
import { pipeline } from '@xenova/transformers';

// Config
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_VERSION = 'all-MiniLM-L6-v2@v1'; // você controla
const CACHE_FILE = path.resolve(process.cwd(), '.cache', 'embeddings-cache.v1.json');

// Tipos
type EmbeddingVector = number[];

type EmbeddingCacheEntry = {
  modelVersion: string;
  textHash: string;
  textNorm: string;
  embedding: EmbeddingVector;
  updatedAt: number;
};

type EmbeddingCacheFile = {
  schemaVersion: 'embedding-cache.v1';
  entries: Record<string, EmbeddingCacheEntry>;
};

let inMemoryCache: EmbeddingCacheFile | null = null;
let embedPipeline: any | null = null;

// Helpers
function normalizeText(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function ensureCacheLoaded(): EmbeddingCacheFile {
  if (inMemoryCache) return inMemoryCache;

  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as EmbeddingCacheFile;
    if (parsed.schemaVersion === 'embedding-cache.v1') {
      inMemoryCache = parsed;
      return parsed;
    }
  } catch {
    // ignore
  }

  inMemoryCache = {
    schemaVersion: 'embedding-cache.v1',
    entries: {},
  };
  return inMemoryCache;
}

function saveCache() {
  if (!inMemoryCache) return;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(inMemoryCache), 'utf8');
}

// Similaridade cosseno
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Carrega pipeline Xenova (lazy)
async function getPipeline() {
  if (!embedPipeline) {
    // você ajusta conforme docs Xenova / transformers.js
    // ex: embedPipeline = await pipeline('feature-extraction', MODEL_ID);
    embedPipeline = await pipeline('feature-extraction', MODEL_ID);
  }
  return embedPipeline;
}

export async function getOrCreateEmbedding(rawText: string): Promise<EmbeddingVector> {
  const cache = ensureCacheLoaded();
  const textNorm = normalizeText(rawText);
  if (!textNorm) return [];

  const key = hashText(`${MODEL_VERSION}::${textNorm}`);
  const hit = cache.entries[key];
  if (hit && hit.modelVersion === MODEL_VERSION) {
    return hit.embedding;
  }

  const pipe = await getPipeline();
  const output = await pipe(textNorm, { pooling: 'mean', normalize: true });
  const embedding: EmbeddingVector = Array.from(output.data ?? output);

  cache.entries[key] = {
    modelVersion: MODEL_VERSION,
    textHash: key,
    textNorm,
    embedding,
    updatedAt: Date.now(),
  };
  saveCache();

  return embedding;
}
