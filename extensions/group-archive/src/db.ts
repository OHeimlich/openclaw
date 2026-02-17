import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

export type GroupRow = {
  jid: string;
  name: string | null;
  first_seen: number;
  last_message: number | null;
  message_count: number;
};

export type MessageRow = {
  id: string;
  group_jid: string;
  sender_id: string;
  sender_name: string | null;
  content: string;
  timestamp: number;
  metadata: string | null;
};

export type DailySummaryRow = {
  id: string;
  group_jid: string;
  date: string;
  summary_text: string;
  message_count: number;
  created_at: number;
};

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export class ArchiveDb {
  private db: DatabaseSync;
  private vecAvailable = false;
  private dims: number;

  constructor(dbDir: string, dims: number) {
    this.dims = dims;
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, "archive.db");
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema();
    this.tryLoadVec();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        jid TEXT PRIMARY KEY,
        name TEXT,
        first_seen INTEGER NOT NULL,
        last_message INTEGER,
        message_count INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL REFERENCES groups(jid),
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_group_timestamp ON messages(group_jid, timestamp)`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL REFERENCES groups(jid),
        date TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        message_count INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_group_date ON daily_summaries(group_jid, date)`,
    );
  }

  private tryLoadVec(): void {
    try {
      const sqliteVec = require("sqlite-vec") as {
        load: (db: DatabaseSync) => void;
        getLoadablePath: () => string;
      };
      this.db.enableLoadExtension(true);
      sqliteVec.load(this.db);
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(\n` +
          `  message_id TEXT PRIMARY KEY,\n` +
          `  embedding FLOAT[${this.dims}]\n` +
          `)`,
      );
      this.vecAvailable = true;
    } catch {
      // sqlite-vec unavailable — semantic search will be disabled
    }
  }

  get vectorEnabled(): boolean {
    return this.vecAvailable;
  }

  // ── Groups ──────────────────────────────────────────────────────────────

  upsertGroup(jid: string, name: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO groups (jid, name, first_seen, last_message, message_count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, groups.name),
           last_message = excluded.last_message,
           message_count = groups.message_count + 1`,
      )
      .run(jid, name, now, now);
  }

  listGroups(): GroupRow[] {
    return this.db
      .prepare(`SELECT * FROM groups ORDER BY last_message DESC`)
      .all() as GroupRow[];
  }

  findGroupByName(name: string): GroupRow | undefined {
    const lower = name.toLowerCase();
    const groups = this.listGroups();
    return groups.find((g) => g.name?.toLowerCase().includes(lower));
  }

  // ── Messages ────────────────────────────────────────────────────────────

  insertMessage(msg: Omit<MessageRow, "id">): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, group_jid, sender_id, sender_name, content, timestamp, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, msg.group_jid, msg.sender_id, msg.sender_name, msg.content, msg.timestamp, msg.metadata);
    return id;
  }

  getMessagesByGroupAndDateRange(
    groupJid: string,
    startTs: number,
    endTs: number,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE group_jid = ? AND timestamp >= ? AND timestamp < ?
         ORDER BY timestamp ASC`,
      )
      .all(groupJid, startTs, endTs) as MessageRow[];
  }

  // ── Embeddings ──────────────────────────────────────────────────────────

  insertEmbedding(messageId: string, embedding: number[]): void {
    if (!this.vecAvailable) return;
    this.db
      .prepare(`INSERT OR REPLACE INTO message_embeddings (message_id, embedding) VALUES (?, ?)`)
      .run(messageId, vectorToBlob(embedding));
  }

  searchSimilar(
    queryVec: number[],
    limit: number,
    groupJid?: string,
  ): Array<MessageRow & { score: number }> {
    if (!this.vecAvailable || queryVec.length === 0) return [];

    const blob = vectorToBlob(queryVec);
    if (groupJid) {
      return this.db
        .prepare(
          `SELECT m.*, (1 - vec_distance_cosine(e.embedding, ?)) AS score
           FROM message_embeddings e
           JOIN messages m ON m.id = e.message_id
           WHERE m.group_jid = ?
           ORDER BY score DESC
           LIMIT ?`,
        )
        .all(blob, groupJid, limit) as Array<MessageRow & { score: number }>;
    }
    return this.db
      .prepare(
        `SELECT m.*, (1 - vec_distance_cosine(e.embedding, ?)) AS score
         FROM message_embeddings e
         JOIN messages m ON m.id = e.message_id
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(blob, limit) as Array<MessageRow & { score: number }>;
  }

  // ── Summaries ───────────────────────────────────────────────────────────

  insertSummary(groupJid: string, date: string, summaryText: string, messageCount: number): void {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO daily_summaries (id, group_jid, date, summary_text, message_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, groupJid, date, summaryText, messageCount, Date.now());
  }

  getSummary(groupJid: string, date: string): DailySummaryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM daily_summaries WHERE group_jid = ? AND date = ?`)
      .get(groupJid, date) as DailySummaryRow | undefined;
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  getGroupsWithMessagesOnDate(startTs: number, endTs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT group_jid FROM messages WHERE timestamp >= ? AND timestamp < ?`,
      )
      .all(startTs, endTs) as Array<{ group_jid: string }>;
    return rows.map((r) => r.group_jid);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
