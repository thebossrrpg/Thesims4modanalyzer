import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.WEB_PORT ?? 4173);
const HOST = process.env.WEB_HOST ?? '0.0.0.0';
const analyzerEntry = path.resolve(process.cwd(), 'dist/src/main.js');
const inlineFaviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff3fb0"/><stop offset="1" stop-color="#f02bd2"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="30">💵</text></svg>`;

const downloadableFiles: Record<string, { filePath: string; mime: string }> = {
  'notioncache.json': { filePath: path.resolve(process.cwd(), 'snapshot.json'), mime: 'application/json' },
  'matchcache.json': { filePath: path.resolve(process.cwd(), '.cache/lookup-cache.v2.json'), mime: 'application/json' },
  'notfoundcache.json': { filePath: path.resolve(process.cwd(), '.cache/ai-decision-cache.v1.json'), mime: 'application/json' },
  'decisionlog.html': { filePath: path.resolve(process.cwd(), 'decisionlog.html'), mime: 'text/html' },
  'ialog.html': { filePath: path.resolve(process.cwd(), 'ialog.html'), mime: 'text/html' },
};

const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TS4 Mod Analyzer</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(inlineFaviconSvg)}" />
  <style>
    :root {
      --card-bg: rgba(248, 248, 248, 0.9);
      --text: #23242a;
      --muted: #6f7280;
      --btn-grad: linear-gradient(90deg, #6282ff 0%, #7646b8 100%);
      --bg-grad: linear-gradient(120deg, #6d8fff 0%, #7f5eb8 100%);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--text);
      background: var(--bg-grad);
      display: grid;
      place-items: center;
      padding: 16px;
    }

    .wrapper {
      width: 100%;
      max-width: 560px;
      background: var(--card-bg);
      border-radius: 14px;
      box-shadow: 0 20px 40px rgba(16, 17, 26, 0.25);
      padding: 28px 28px 20px;
      backdrop-filter: blur(2px);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 40px;
      letter-spacing: 0.2px;
    }

    .subtitle {
      margin: 0 0 22px;
      color: var(--muted);
      font-size: 14px;
    }

    label {
      display: block;
      font-size: 14px;
      margin-bottom: 8px;
      color: #44475a;
      font-weight: 600;
    }

    input {
      width: 100%;
      padding: 11px 12px;
      border: 1px solid #d4d4d9;
      border-radius: 9px;
      font-size: 14px;
      outline: none;
      margin-bottom: 14px;
      background: #fff;
    }

    input:focus { border-color: #6f7ef2; box-shadow: 0 0 0 3px rgba(100, 121, 255, 0.15); }

    button {
      width: 100%;
      border: none;
      border-radius: 9px;
      padding: 12px;
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      background: var(--btn-grad);
      cursor: pointer;
    }

    pre {
      margin: 16px 0 8px;
      white-space: pre-wrap;
      border-radius: 9px;
      background: #fff;
      border: 1px solid #e1e3eb;
      padding: 10px 12px;
      min-height: 86px;
      max-height: 190px;
      overflow: auto;
      color: #2f3342;
    }

    .ia-note {
      margin: 8px 0 0;
      color: #555d7a;
      font-size: 13px;
    }

    .downloads {
      margin-top: 14px;
      border-top: 1px solid #d7d9e2;
      padding-top: 12px;
      display: grid;
      gap: 8px;
      font-size: 13px;
    }

    .download-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: #545a73;
    }

    .download-row a {
      color: #4f56c6;
      text-decoration: none;
      font-weight: 600;
    }

    .footer {
      margin-top: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 12px;
      color: #777b8f;
    }

    .footer-icon {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: linear-gradient(135deg, #ff3fb0, #f02bd2);
      display: inline-grid;
      place-items: center;
      color: #fff;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <main class="wrapper">
    <h1>TS4 Mod Analyzer</h1>
    <p class="subtitle">Interface local (mostly offline) com pipeline canônico Phase 0 → Phase 3.</p>

    <label for="url">URL do Mod</label>
    <input id="url" type="url" placeholder="https://www.patreon.com/posts/ultimate-pack-123456" />
    <button id="analyze">Analisar</button>

    <pre id="summary">Aguardando análise.</pre>
    <p class="ia-note" id="ia-note"></p>

    <section class="downloads" aria-label="Downloads de auditoria">
      <div><strong>Downloads de cache:</strong></div>
      <div class="download-row">
        <a href="/download/notioncache.json">notioncache.json</a>
        <a href="/download/matchcache.json">matchcache.json</a>
        <a href="/download/notfoundcache.json">notfoundcache.json</a>
      </div>
      <div><strong>Downloads de logs:</strong></div>
      <div class="download-row">
        <a href="/download/decisionlog.html">decisionlog.html</a>
        <a href="/download/ialog.html">ialog.html</a>
      </div>
    </section>

    <footer class="footer">
      <span class="footer-icon">💵</span>
      <span>Criado por Akin UnpaidSimmer • v1.0.5</span>
    </footer>
  </main>

  <script>
    const btn = document.getElementById('analyze');
    const input = document.getElementById('url');
    const summary = document.getElementById('summary');
    const iaNote = document.getElementById('ia-note');

    function render(data) {
      const status = data.status || 'UNKNOWN';
      const source = data.phaseResolved || 'N/A';
      const reason = data.reason || 'sem motivo';
      const found = data.found ? '\nMatch: ' + data.found.title + ' (' + data.found.pageId + ')' + '\nNotion: ' + (data.found.pageUrl || 'N/A') : '';
      const amb = data.ambiguous?.pageIds?.length ? '\nCandidatos: ' + data.ambiguous.pageIds.join(', ') : '';
      summary.textContent = 'Status: ' + status + '\nOrigem: ' + source + '\nMotivo: ' + reason + found + amb;
      iaNote.textContent = source === 'PHASE_3' ? 'Decisão usou IA como último recurso.' : 'Sem uso de IA na decisão final.';
    }

    btn.addEventListener('click', async () => {
      const url = input.value.trim();
      if (!url) return;
      summary.textContent = 'Analisando...';
      iaNote.textContent = '';
      try {
        const res = await fetch('/api/analyze?url=' + encodeURIComponent(url));
        const data = await res.json();
        if (!res.ok) {
          summary.textContent = data.error || 'Erro inesperado';
          return;
        }
        render(data);
      } catch (err) {
        summary.textContent = 'Falha ao conectar no servidor local.';
      }
    });
  </script>
</body>
</html>`;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function parseAnalyzerJson(raw: string): any {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Saída do analyzer não contém JSON válido.');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function analyzeUrl(inputUrl: string): Promise<any> {
  await fs.access(analyzerEntry);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [analyzerEntry, inputUrl, '--json'], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Analyzer saiu com código ${code}`));
        return;
      }
      try {
        resolve(parseAnalyzerJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'missing_url' });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (requestUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (requestUrl.pathname === '/api/analyze') {
    const inputUrl = requestUrl.searchParams.get('url')?.trim();
    if (!inputUrl) {
      sendJson(res, 400, { error: 'url_required' });
      return;
    }

    try {
      const result = await analyzeUrl(inputUrl);
      sendJson(res, 200, result);
    } catch (error: any) {
      sendJson(res, 500, {
        error: 'analyze_failed',
        message: String(error?.message ?? error),
        hint: 'Execute npm run build antes de iniciar a interface web.',
      });
    }
    return;
  }

  if (requestUrl.pathname.startsWith('/download/')) {
    const key = requestUrl.pathname.replace('/download/', '');
    const def = downloadableFiles[key];
    if (!def) {
      sendJson(res, 404, { error: 'file_not_mapped' });
      return;
    }

    try {
      const body = await fs.readFile(def.filePath);
      res.writeHead(200, {
        'Content-Type': def.mime,
        'Content-Disposition': `attachment; filename="${key}"`,
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: 'file_not_found', file: key });
    }
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`🌐 TS4 Mod Analyzer web UI em http://${HOST}:${PORT}`);
});
