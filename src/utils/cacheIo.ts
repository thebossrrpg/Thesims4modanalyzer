// src/utils/cacheIo.ts
//
// Utilitários genéricos para caches em arquivo.
// - Garante a pasta .cache
// - Leitura JSON segura (retorna null se não existir/quebrado)
// - Escrita atômica (tmp + rename) para evitar corrupção
//
// Observação: este arquivo NÃO define caches específicos (isso fica em src/cache/*).


import fs from "fs";
import path from "path";


export const CACHE_DIR = path.resolve(process.cwd(), ".cache");


/** Garante que a pasta .cache exista. */
export function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}


/** Retorna Date.now() (facilita mock/teste no futuro). */
export function nowMs(): number {
  return Date.now();
}


/**
 * Lê e faz parse de um JSON.
 * - Retorna null se o arquivo não existir, estiver inválido, ou der erro de parse.
 */
export function safeReadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}


/**
 * Escrita atômica:
 * - escreve em <file>.tmp
 * - renomeia para o alvo
 *
 * Isso evita arquivo “meio escrito” se o processo cair no meio.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  ensureCacheDir();


  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}


/** Helper: apaga arquivo se existir (útil para resetar cache). */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}


/** Helper: true se (agora - timestamp) > ttlMs */
export function isExpired(timestampMs: number, ttlMs: number): boolean {
  return nowMs() - timestampMs > ttlMs;
}