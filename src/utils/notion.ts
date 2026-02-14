/**
 * Constrói URL da página Notion a partir do notion_id e título opcional.
 * 
 * @param notionId - ID da página Notion (com ou sem hífens)
 * @param title - Título opcional para URL bonita
 * @returns URL completa da página Notion
 * 
 * @example
 * getNotionPageUrl("2e53ae64-a3a5-8099-b928-ff0ef167d3e2", "Sim Control Hub")
 * → "https://www.notion.so/Sim-Control-Hub-2e53ae64a3a58099b928ff0ef167d3e2"
 */
export function getNotionPageUrl(notionId: string, title?: string | null): string {
  const cleanId = notionId.replace(/-/g, '');
  
  if (title) {
    const slug = title
      .trim()
      .replace(/[^\w\s-]/g, '') // remove caracteres especiais
      .replace(/\s+/g, '-')      // espaços → hífens
      .replace(/-+/g, '-')       // múltiplos hífens → 1
      .toLowerCase();
    
    return `https://www.notion.so/${slug}-${cleanId}`;
  }
  
  return `https://www.notion.so/${cleanId}`;
}
