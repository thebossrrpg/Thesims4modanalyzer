// src/notion/notionClient.ts
//
// Cliente mínimo para Notion API (oficial) focado em Phase 3.
// Busca detalhes "live" por pageId para confirmar/desambiguar candidatos.
//
// Requer:
// - process.env.NOTION_API_KEY
//
// Opcional:
// - process.env.NOTION_API_VERSION (default: 2022-06-28)
//
// Observação importante:
// - Este cliente NÃO faz cache. Cache é responsabilidade de src/cache/pageIdNotionCache.ts
// - Se não houver NOTION_API_KEY, ele falha com erro explícito (não retorna null silencioso).

export type NotionLivePageDTO = {
  pageId: string;
  title: string | null;
  creator: string | null;
  url: string | null;
  lastEditedTime: string | null;
};

type NotionApiUser = {
  id: string;
  name?: string | null;
};

type NotionApiRichText = {
  plain_text?: string;
};

type NotionApiTitleProperty = {
  type: "title";
  title: NotionApiRichText[];
};

type NotionApiProperty =
  | NotionApiTitleProperty
  | { type: string; [k: string]: unknown };

type NotionApiPage = {
  id: string;
  url?: string | null;
  last_edited_time?: string | null;

  created_by?: NotionApiUser | null;

  // O Notion API devolve propriedades num shape meio flexível:
  // properties: { [propName]: { type: "...", ... } }
  properties?: Record<string, NotionApiProperty> | null;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `[notionClient] Missing env var ${name}. ` +
      `Set NOTION_API_KEY to enable Notion live lookups (Phase 3).`
    );
  }
  return v.trim();
}

function notionHeaders(): Record<string, string> {
  const token = requireEnv("NOTION_API_KEY");
  const version = (process.env.NOTION_API_VERSION || "2022-06-28").trim();

  return {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": version,
    "Content-Type": "application/json"
  };
}

function extractTitleFromPage(page: NotionApiPage): string | null {
  const props = page.properties ?? null;
  if (!props) return null;

  // Procura a primeira property do tipo "title" (nome dela varia por DB)
  for (const prop of Object.values(props)) {
    if (prop && (prop as any).type === "title") {
      const titleProp = prop as NotionApiTitleProperty;
      const parts = (titleProp.title || [])
        .map((t) => (t?.plain_text ?? "").trim())
        .filter(Boolean);
      const joined = parts.join("");
      return joined || null;
    }
  }

  return null;
}

function normalizePageId(pageId: string): string {
  // Aceita com/sem hífen. Notion API aceita os dois, mas vamos limpar.
  const raw = String(pageId || "").trim();
  if (!raw) return "";
  return raw.replace(/[^a-f0-9]/gi, "");
}

export class NotionClient {
  async getPage(pageId: string): Promise<NotionLivePageDTO> {
    const normalized = normalizePageId(pageId);
    if (!normalized) {
      throw new Error("[notionClient] getPage: pageId vazio");
    }

    const url = `https://api.notion.com/v1/pages/${normalized}`;

    const res = await fetch(url, {
      method: "GET",
      headers: notionHeaders()
    });

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(
        `[notionClient] Notion API error ${res.status} for page ${pageId}: ${body}`
      );
    }

    const page = (await res.json()) as NotionApiPage;

    const title = extractTitleFromPage(page);
    const creator = page.created_by?.name ?? null;

    return {
      pageId,
      title,
      creator,
      url: page.url ?? null,
      lastEditedTime: page.last_edited_time ?? null
    };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t?.slice(0, 5000) || "";
  } catch {
    return "";
  }
}