import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.WEB_PORT ?? 4173);
const HOST = process.env.WEB_HOST ?? '0.0.0.0';
const analyzerEntry = path.resolve(process.cwd(), 'dist/src/main.js');

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
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TS4 Mod Analyzer • Web Offline</title>
  <style>
    body { font-family: Inter, system-ui, Arial, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #0b0f17; color: #ecf1ff; }
    h1 { margin-bottom: .5rem; }
    .card { background:#141b2a; border:1px solid #26324c; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
    input, button { padding: .7rem .8rem; border-radius: 8px; border:1px solid #33466f; }
    input { width: 100%; background:#0d1422; color:#fff; margin-bottom: .75rem; }
    button { background:#2d7fff; color:white; font-weight:600; cursor:pointer; }
    pre { white-space: pre-wrap; background:#0d1422; border-radius:8px; padding: .8rem; overflow:auto; }
    .muted { color:#8fa3cc; font-size:.95rem; }
    .row { display:flex; gap:.5rem; flex-wrap: wrap; }
    a { color:#84b3ff; }
    .ok { color:#77ffb0; } .warn { color:#ffd479; } .bad { color:#ff8585; }
  </style>
</head>
<body>
  <h1>🧠 TS4 Mod Analyzer</h1>
  <p class="muted">Interface web local (mostly offline). Usa snapshot/caches locais e executa o pipeline existente via CLI.</p>

  <div class="card">
    <label for="url">URL do mod</label>
    <input id="url" type="url" placeholder="https://..." />
    <button id="analyze">Analisar</button>
    <p class="muted" id="ia-note"></p>
  </div>

  <div class="card">
    <strong>Resumo</strong>
    <pre id="summary">Aguardando análise.</pre>
  </div>

  <div class="card">
    <strong>Downloads de cache</strong>
    <div class="row">
      <a href="/download/notioncache.json">notioncache.json</a>
      <a href="/download/matchcache.json">matchcache.json</a>
      <a href="/download/notfoundcache.json">notfoundcache.json</a>
    </div>
    <br/>
    <strong>Downloads de logs</strong>
    <div class="row">
      <a href="/download/decisionlog.html">decisionlog.html</a>
      <a href="/download/ialog.html">ialog.html</a>
    </div>
  </div>

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
