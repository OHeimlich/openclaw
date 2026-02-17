import type { ArchiveDb } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import type { PluginLogger } from "openclaw/plugin-sdk";

export type CaptureContext = {
  db: ArchiveDb;
  embeddings: EmbeddingClient;
  logger: PluginLogger;
};

export function createCaptureHandler(ctx: CaptureContext) {
  return (
    event: { from: string; content: string; timestamp?: number; metadata?: Record<string, unknown> },
    hookCtx: { channelId: string; conversationId?: string },
  ) => {
    if (hookCtx.channelId !== "whatsapp") return;
    if (!hookCtx.conversationId?.endsWith("@g.us")) return;

    const content = event.content?.trim();
    if (!content) return;

    const groupJid = hookCtx.conversationId;
    const groupName = (event.metadata?.groupName as string) ?? null;
    const senderName = (event.metadata?.pushName as string) ?? null;

    ctx.db.upsertGroup(groupJid, groupName);

    const messageId = ctx.db.insertMessage({
      group_jid: groupJid,
      sender_id: event.from,
      sender_name: senderName,
      content,
      timestamp: event.timestamp ?? Date.now(),
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });

    // Generate embedding asynchronously — don't block the hook
    if (ctx.db.vectorEnabled) {
      ctx.embeddings.embed(content).then(
        (vec) => ctx.db.insertEmbedding(messageId, vec),
        (err) => ctx.logger.warn(`group-archive: embedding failed: ${String(err)}`),
      );
    }
  };
}
