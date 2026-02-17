import type { ArchiveDb } from "./db.js";
import type { GroupArchiveConfig } from "./config.js";
import type { EmbeddingClient } from "./embeddings.js";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { semanticSearch, formatSearchResults } from "./search.js";
import { generateAndStoreSummary } from "./summary.js";

export type CommandDeps = {
  db: ArchiveDb;
  config: GroupArchiveConfig;
  embeddings: EmbeddingClient;
  logger: PluginLogger;
};

// Commands are only meaningful in WhatsApp DM context.
// The suppress hook already blocks outbound messages to groups,
// but as an extra safety net we silently no-op if invoked from a group.
type Ctx = { from?: string; to?: string; args?: string; channel: string; channelId?: string };

function isGroupContext(ctx: Ctx): boolean {
  // `to` carries the conversation JID on WhatsApp
  return ctx.to?.endsWith("@g.us") === true;
}

function buildGroupNameMap(deps: CommandDeps): Map<string, string> {
  const groups = deps.db.listGroups();
  const map = new Map<string, string>();
  for (const g of groups) {
    if (g.name) map.set(g.jid, g.name);
  }
  return map;
}

export function createSearchCommand(deps: CommandDeps) {
  return {
    name: "search",
    description: "Semantic search across archived WhatsApp group messages",
    acceptsArgs: true,
    async handler(ctx: Ctx) {
      if (isGroupContext(ctx)) return { text: "" };
      if (!deps.db.vectorEnabled) return { text: "Semantic search is unavailable (sqlite-vec not loaded)." };

      const raw = ctx.args?.trim() ?? "";
      if (!raw) return { text: "Usage: /search [group-name] <query>" };

      // Try to detect if first word is a group name
      const groups = deps.db.listGroups();
      const groupNames = buildGroupNameMap(deps);
      const words = raw.split(/\s+/);
      let groupJid: string | undefined;
      let query = raw;

      if (words.length > 1) {
        const candidate = words[0].toLowerCase();
        const matchedGroup = groups.find((g) => g.name?.toLowerCase().includes(candidate));
        if (matchedGroup) {
          groupJid = matchedGroup.jid;
          query = words.slice(1).join(" ");
        }
      }

      try {
        const results = await semanticSearch(deps.db, deps.embeddings, query, { groupJid });
        return { text: formatSearchResults(results, groupNames) };
      } catch (err) {
        deps.logger.warn(`group-archive: search failed: ${String(err)}`);
        return { text: `Search failed: ${String(err)}` };
      }
    },
  };
}

export function createSummaryCommand(deps: CommandDeps) {
  return {
    name: "summary",
    description: "Get or generate a daily summary for a WhatsApp group",
    acceptsArgs: true,
    async handler(ctx: Ctx) {
      if (isGroupContext(ctx)) return { text: "" };

      const raw = ctx.args?.trim() ?? "";
      // Parse: /summary [group-name] [YYYY-MM-DD]
      const tokens = raw.split(/\s+/).filter(Boolean);

      // Default to yesterday
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      let date = yesterday;
      let groupName: string | undefined;

      for (const token of tokens) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
          date = token;
        } else {
          groupName = token;
        }
      }

      const groups = deps.db.listGroups();
      if (groups.length === 0) return { text: "No groups archived yet." };

      let targetGroups = groups;
      if (groupName) {
        const matched = groups.filter((g) =>
          g.name?.toLowerCase().includes(groupName!.toLowerCase()),
        );
        if (matched.length === 0) {
          return { text: `No group found matching "${groupName}".` };
        }
        targetGroups = matched;
      }

      const parts: string[] = [];
      for (const group of targetGroups) {
        try {
          const summaryText = await generateAndStoreSummary(
            deps.db,
            deps.config,
            group.jid,
            date,
            deps.logger,
          );
          if (summaryText) {
            const label = group.name ?? group.jid;
            parts.push(`*${label}* (${date})\n${summaryText}`);
          }
        } catch (err) {
          deps.logger.warn(`group-archive: summary command failed for ${group.jid}: ${String(err)}`);
        }
      }

      if (parts.length === 0) return { text: `No messages found for ${date}.` };
      return { text: parts.join("\n\n---\n\n") };
    },
  };
}

export function createGroupsCommand(deps: CommandDeps) {
  return {
    name: "groups",
    description: "List all archived WhatsApp groups with message counts",
    acceptsArgs: false,
    handler(ctx: Ctx) {
      if (isGroupContext(ctx)) return { text: "" };

      const groups = deps.db.listGroups();
      if (groups.length === 0) return { text: "No groups archived yet." };

      const lines = groups.map((g) => {
        const name = g.name ?? g.jid;
        const lastSeen = g.last_message
          ? new Date(g.last_message).toISOString().slice(0, 16).replace("T", " ")
          : "never";
        return `- ${name} — ${g.message_count} messages (last: ${lastSeen})`;
      });

      return { text: `Archived groups:\n\n${lines.join("\n")}` };
    },
  };
}
