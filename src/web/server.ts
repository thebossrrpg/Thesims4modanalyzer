import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ajuste se seu build gerar outra estrutura
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist", "src", "main.js");

const PORT = Number(process.env.PORT ?? 3000);
const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS ?? 45_000);

type ApiError = {
  error: string;
  details?: string;
};

const app = express();

app.use(express.json({ limit: "32kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ts4modanalyzer-web",
    cliEntry: CLI_ENTRY,
    timeoutMs: ANALYZE_TIMEOUT_MS,
  });
});

app.post("/api/analyze", async (req, res) => {
  const startedAt = Date.now();

  const url = String(req.body?.url ?? "").trim();

  if (!url) {
    return res.status(400).json({
      error: "missing_url",
      details: "Envie { url } no body JSON.",
    } satisfies ApiError);
  }

  // validação básica (o CLI também valida)
  if (!/^https?:\/\//i.test(url)) {
    return res.status(422).json({
      error: "invalid_url",
      details: "A URL deve começar com http:// ou https://",
    } satisfies ApiError);
  }

  try {
    const result = await runAnalyzerCli(url);

    const durationMs = Date.now() - startedAt;
    console.log(
      `[web] analyze ok url=${url} status=${result?.status ?? "unknown"} durationMs=${durationMs}`
    );

    return res.json(result);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const message = String(err?.message ?? err ?? "unknown_error");
    const code = String(err?.code ?? "");

    if (code === "CLI_TIMEOUT") {
      console.error(`[web] analyze timeout url=${url} durationMs=${durationMs}`);
      return res.status(504).json({
        error: "cli_timeout",
        details: `A análise excedeu ${ANALYZE_TIMEOUT_MS}ms.`,
      } satisfies ApiError);
    }

    console.error(`[web] analyze fail url=${url} durationMs=${durationMs} err=${message}`);

    return res.status(500).json({
      error: "cli_execution_failed",
      details: message,
    } satisfies ApiError);
  }
});

// fallback para abrir a UI no navegador
app.get("/{*any}", (_req, res) => {
res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[web] server running on http://localhost:${PORT}`);
  console.log(`[web] projectRoot=${PROJECT_ROOT}`);
  console.log(`[web] cliEntry=${CLI_ENTRY}`);
});

function runAnalyzerCli(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, url, "--json"], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ANALYZE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      // útil para ver logs do CLI em tempo real no terminal do servidor
      process.stderr.write(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        const e: any = new Error("CLI timed out");
        e.code = "CLI_TIMEOUT";
        return reject(e);
      }

      if (code !== 0) {
        return reject(
          new Error(
            `CLI exited with code ${code}. stderr=${truncate(stderr)} stdout=${truncate(stdout)}`
          )
        );
      }

      // Preferimos stdout puro JSON. Mas, como defesa, tentamos extrair o último bloco JSON.
      const parsed = tryParseAnalyzerJson(stdout);
      if (!parsed.ok) {
        return reject(
          new Error(
            `Failed to parse CLI JSON. ${parsed.reason}. stdout=${truncate(stdout)} stderr=${truncate(
              stderr
            )}`
          )
        );
      }

      resolve(parsed.value);
    });
  });
}

function truncate(s: string, max = 1200): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

function tryParseAnalyzerJson(stdout: string):
  | { ok: true; value: any }
  | { ok: false; reason: string } {
  const text = String(stdout ?? "").trim();
  if (!text) return { ok: false, reason: "empty stdout" };

  // 1) tentativa direta
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {}

  // 2) fallback: extrair do primeiro "{" até o último "}"
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {}
  }

  return { ok: false, reason: "stdout is not valid JSON" };
}