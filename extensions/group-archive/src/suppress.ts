import type { PluginLogger } from "openclaw/plugin-sdk";

export function createSuppressHandler(logger: PluginLogger) {
  return (
    _event: { to: string; content: string; metadata?: Record<string, unknown> },
    ctx: { channelId: string; conversationId?: string },
  ) => {
    if (ctx.channelId !== "whatsapp") return;
    if (!ctx.conversationId?.endsWith("@g.us")) return;

    logger.info(`group-archive: suppressed outbound message to group ${ctx.conversationId}`);
    return { cancel: true };
  };
}
