const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_DB_PATH = "~/.openclaw/group-archive";
const DEFAULT_SCHEDULED_TIME = "00:00";
const DEFAULT_TIMEZONE = "UTC";

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export type GroupArchiveConfig = {
  embedding: {
    provider: "openai";
    apiKey: string;
    model: string;
    dims: number;
  };
  summary: {
    provider: string;
    model: string;
    apiKey: string;
  };
  scheduledTime: string;
  timezone: string;
  dbPath: string;
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const groupArchiveConfigSchema = {
  parse(value: unknown): GroupArchiveConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("group-archive config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "summary", "scheduledTime", "timezone", "dbPath"],
      "group-archive config",
    );

    // --- embedding ---
    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["provider", "apiKey", "model"], "embedding config");
    const embeddingModel =
      typeof embedding.model === "string" ? embedding.model : DEFAULT_EMBEDDING_MODEL;
    const dims = EMBEDDING_DIMENSIONS[embeddingModel];
    if (!dims) {
      throw new Error(`Unsupported embedding model: ${embeddingModel}`);
    }

    // --- summary ---
    const summary = cfg.summary as Record<string, unknown> | undefined;
    if (!summary || typeof summary.apiKey !== "string" || typeof summary.model !== "string") {
      throw new Error("summary.apiKey and summary.model are required");
    }
    assertAllowedKeys(summary, ["provider", "model", "apiKey"], "summary config");
    const summaryProvider = typeof summary.provider === "string" ? summary.provider : "openai";

    // --- optional ---
    const scheduledTime =
      typeof cfg.scheduledTime === "string" ? cfg.scheduledTime : DEFAULT_SCHEDULED_TIME;
    if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
      throw new Error('scheduledTime must be "HH:MM"');
    }
    const timezone = typeof cfg.timezone === "string" ? cfg.timezone : DEFAULT_TIMEZONE;
    const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH;

    return {
      embedding: {
        provider: "openai",
        apiKey: resolveEnvVars(embedding.apiKey),
        model: embeddingModel,
        dims,
      },
      summary: {
        provider: summaryProvider,
        model: summary.model,
        apiKey: resolveEnvVars(summary.apiKey),
      },
      scheduledTime,
      timezone,
      dbPath,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_EMBEDDING_MODEL,
      help: "OpenAI embedding model to use",
    },
    "summary.provider": {
      label: "Summary LLM Provider",
      placeholder: "openai",
      help: 'Provider for summary generation ("openai" or "anthropic")',
    },
    "summary.model": {
      label: "Summary Model",
      placeholder: "gpt-4o-mini",
      help: "Model for generating daily summaries",
    },
    "summary.apiKey": {
      label: "Summary API Key",
      sensitive: true,
      help: "API key for the summary LLM provider",
    },
    scheduledTime: {
      label: "Scheduled Time",
      placeholder: DEFAULT_SCHEDULED_TIME,
      help: 'Daily summary generation time in "HH:MM" format',
    },
    timezone: {
      label: "Timezone",
      placeholder: DEFAULT_TIMEZONE,
      help: "Timezone for scheduled summary generation",
    },
    dbPath: {
      label: "Database Path",
      placeholder: DEFAULT_DB_PATH,
      advanced: true,
    },
  },
};
