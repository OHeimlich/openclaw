import type { ArchiveDb } from "./db.js";
import type { GroupArchiveConfig } from "./config.js";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { generateAndStoreSummary, midnightUtcForDate } from "./summary.js";

function getYesterdayDate(timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const yesterday = new Date(Date.now() - 86_400_000);
  return formatter.format(yesterday); // "YYYY-MM-DD"
}

function currentTimeInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function createScheduler(
  db: ArchiveDb,
  config: GroupArchiveConfig,
  logger: PluginLogger,
): { start: () => void; stop: () => void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastRunDate: string | null = null;

  async function tick() {
    const currentTime = currentTimeInTimezone(config.timezone);
    if (currentTime !== config.scheduledTime) return;

    const yesterday = getYesterdayDate(config.timezone);
    if (lastRunDate === yesterday) return; // Already ran today
    lastRunDate = yesterday;

    logger.info(`group-archive: scheduler triggered — generating summaries for ${yesterday}`);

    const dayStart = midnightUtcForDate(yesterday, config.timezone);
    const dayEnd = dayStart + 86_400_000;
    const groupJids = db.getGroupsWithMessagesOnDate(dayStart, dayEnd);

    for (const groupJid of groupJids) {
      try {
        await generateAndStoreSummary(db, config, groupJid, yesterday, logger);
      } catch (err) {
        logger.warn(`group-archive: summary failed for ${groupJid}: ${String(err)}`);
      }
    }

    logger.info(
      `group-archive: scheduler done — processed ${groupJids.length} groups for ${yesterday}`,
    );
  }

  return {
    start() {
      logger.info(
        `group-archive: scheduler started (daily at ${config.scheduledTime} ${config.timezone})`,
      );
      interval = setInterval(() => void tick(), 60_000);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
