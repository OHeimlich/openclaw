import type { ArchiveDb, MessageRow } from "./db.js";
import type { GroupArchiveConfig } from "./config.js";
import type { PluginLogger } from "openclaw/plugin-sdk";
import OpenAI from "openai";

function formatTranscript(messages: MessageRow[]): string {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp).toISOString().slice(11, 16);
      const sender = m.sender_name ?? m.sender_id;
      return `[${time}] ${sender}: ${m.content}`;
    })
    .join("\n");
}

const SUMMARY_SYSTEM_PROMPT = `You are a group chat summarizer. Summarize the conversation transcript below.
Rules:
- Write the summary in the SAME LANGUAGE as the conversation. If the conversation is in Hebrew, summarize in Hebrew. If in English, summarize in English. Etc.
- Focus on: key decisions, action items, important topics, notable announcements.
- Use bullet points.
- Be concise but thorough — don't miss important details.
- If there are multiple topics, organize with headers.`;

export async function generateSummary(
  config: GroupArchiveConfig,
  messages: MessageRow[],
  logger: PluginLogger,
): Promise<string> {
  // Cap transcript at ~100k chars to stay within LLM context limits
  let transcript = formatTranscript(messages);
  if (transcript.length > 100_000) {
    transcript = transcript.slice(0, 100_000) + "\n\n[...transcript truncated...]";
  }

  if (config.summary.provider === "anthropic") {
    return generateWithAnthropic(config, transcript, logger);
  }
  return generateWithOpenAI(config, transcript, logger);
}

async function generateWithOpenAI(
  config: GroupArchiveConfig,
  transcript: string,
  _logger: PluginLogger,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.summary.apiKey });
  const response = await client.chat.completions.create({
    model: config.summary.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `Here is the group chat transcript:\n\n${transcript}` },
    ],
    max_tokens: 2000,
  });
  return response.choices[0]?.message?.content ?? "";
}

async function generateWithAnthropic(
  config: GroupArchiveConfig,
  transcript: string,
  _logger: PluginLogger,
): Promise<string> {
  // Use the Anthropic messages API directly
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.summary.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.summary.model,
      max_tokens: 2000,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Here is the group chat transcript:\n\n${transcript}` },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Compute the UTC timestamp for midnight of `dateStr` (YYYY-MM-DD) in the given timezone.
 * We create a date formatter that outputs a full ISO-like string in the target tz,
 * then parse it back to get the UTC epoch.
 */
export function midnightUtcForDate(dateStr: string, timezone: string): number {
  // Parse the date parts
  const [year, month, day] = dateStr.split("-").map(Number);
  // Create a rough UTC date then adjust
  // Strategy: iterate to find the UTC instant where the local date matches
  const rough = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  // Binary-ish search: try offsets from -14h to +14h from rough noon UTC
  for (let offsetH = -14; offsetH <= 14; offsetH++) {
    const candidate = new Date(rough.getTime() + offsetH * 3_600_000);
    const localDate = fmt.format(candidate);
    if (localDate === dateStr) {
      // Found a time on the right local date — now find midnight
      // Get hour/minute in the tz
      const timeFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const parts = timeFmt.format(candidate).split(":");
      const localH = Number(parts[0]);
      const localM = Number(parts[1]);
      const localS = Number(parts[2]);
      return candidate.getTime() - (localH * 3_600_000 + localM * 60_000 + localS * 1_000);
    }
  }
  // Fallback: treat as UTC
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}

export async function generateAndStoreSummary(
  db: ArchiveDb,
  config: GroupArchiveConfig,
  groupJid: string,
  date: string,
  logger: PluginLogger,
): Promise<string> {
  // Check if summary already exists
  const existing = db.getSummary(groupJid, date);
  if (existing) return existing.summary_text;

  // Parse date to timezone-correct timestamp range
  const dayStart = midnightUtcForDate(date, config.timezone);
  const dayEnd = dayStart + 86_400_000;

  const messages = db.getMessagesByGroupAndDateRange(groupJid, dayStart, dayEnd);
  if (messages.length === 0) return "";

  logger.info(`group-archive: generating summary for ${groupJid} on ${date} (${messages.length} messages)`);
  const summaryText = await generateSummary(config, messages, logger);
  db.insertSummary(groupJid, date, summaryText, messages.length);
  return summaryText;
}
