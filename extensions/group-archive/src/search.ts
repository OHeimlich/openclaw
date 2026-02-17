import type { ArchiveDb, MessageRow } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";

export type SearchResult = MessageRow & { score: number };

export async function semanticSearch(
  db: ArchiveDb,
  embeddings: EmbeddingClient,
  query: string,
  opts?: { groupJid?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 10;
  const queryVec = await embeddings.embed(query);
  return db.searchSimilar(queryVec, limit, opts?.groupJid);
}

export function formatSearchResults(results: SearchResult[], groupNames: Map<string, string>): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const groupLabel = groupNames.get(r.group_jid) ?? r.group_jid;
      const date = new Date(r.timestamp).toISOString().slice(0, 16).replace("T", " ");
      const sender = r.sender_name ?? r.sender_id;
      const score = (r.score * 100).toFixed(0);
      return `${i + 1}. [${score}%] ${groupLabel} — ${date}\n   ${sender}: ${r.content.slice(0, 200)}`;
    })
    .join("\n\n");
}
