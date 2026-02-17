import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { groupArchiveConfigSchema, type GroupArchiveConfig } from "./src/config.js";
import { ArchiveDb } from "./src/db.js";
import { EmbeddingClient } from "./src/embeddings.js";
import { createCaptureHandler } from "./src/capture.js";
import { createSuppressHandler } from "./src/suppress.js";
import { createSearchCommand, createSummaryCommand, createGroupsCommand } from "./src/commands.js";
import { createScheduler } from "./src/scheduler.js";

const plugin = {
  id: "group-archive",
  name: "Group Archive",
  description: "WhatsApp group message archival with semantic search and daily summaries",
  configSchema: groupArchiveConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = groupArchiveConfigSchema.parse(api.pluginConfig) as GroupArchiveConfig;
    const dbDir = api.resolvePath(config.dbPath);
    const db = new ArchiveDb(dbDir, config.embedding.dims);
    const embeddings = new EmbeddingClient(config.embedding.apiKey, config.embedding.model);
    const logger = api.logger;

    // Message capture hook — store all WhatsApp group messages
    api.on("message_received", createCaptureHandler({ db, embeddings, logger }));

    // Suppress hook — prevent bot from replying in groups (high priority)
    api.on("message_sending", createSuppressHandler(logger), { priority: 100 });

    // DM commands
    const deps = { db, config, embeddings, logger };
    api.registerCommand(createSearchCommand(deps));
    api.registerCommand(createSummaryCommand(deps));
    api.registerCommand(createGroupsCommand(deps));

    // Daily summary scheduler
    const scheduler = createScheduler(db, config, logger);
    api.registerService({
      id: "group-archive-scheduler",
      start: () => {
        scheduler.start();
        logger.info(`group-archive: plugin loaded (db: ${dbDir}, vec: ${db.vectorEnabled})`);
      },
      stop: () => {
        scheduler.stop();
        db.close();
        logger.info("group-archive: stopped");
      },
    });
  },
};

export default plugin;
