/**
 * Persistent search history:
 * - Turso (libSQL) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set (survives Render sleep)
 * - Local JSON file otherwise (dev / ephemeral Free disk)
 */
const fs = require("fs");
const path = require("path");

const MAX_HISTORY = 500;

function createFileStore(dataDir) {
  const historyFile = path.join(dataDir, "searches.json");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  function read() {
    try {
      if (!fs.existsSync(historyFile)) return [];
      const raw = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function write(items) {
    fs.writeFileSync(historyFile, JSON.stringify(items.slice(0, MAX_HISTORY), null, 2));
  }

  let cache = read();

  return {
    kind: "file",
    async list(limit = 100) {
      return cache.slice(0, Math.min(limit, MAX_HISTORY));
    },
    async size() {
      return cache.length;
    },
    async push(entry) {
      cache.unshift(entry);
      if (cache.length > MAX_HISTORY) cache.length = MAX_HISTORY;
      write(cache);
    },
    async clear() {
      cache = [];
      write(cache);
    },
  };
}

async function createTursoStore(url, authToken) {
  const { createClient } = require("@libsql/client");
  const client = createClient({ url, authToken });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS searches (
      id TEXT PRIMARY KEY,
      at_ms INTEGER NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_searches_at_ms ON searches(at_ms DESC)`,
  );

  return {
    kind: "turso",
    async list(limit = 100) {
      const lim = Math.min(Number(limit) || 100, MAX_HISTORY);
      const rs = await client.execute({
        sql: `SELECT payload FROM searches ORDER BY at_ms DESC LIMIT ?`,
        args: [lim],
      });
      return rs.rows.map((row) => {
        try {
          return JSON.parse(row.payload);
        } catch {
          return null;
        }
      }).filter(Boolean);
    },
    async size() {
      const rs = await client.execute(`SELECT COUNT(*) AS c FROM searches`);
      return Number(rs.rows[0]?.c || 0);
    },
    async push(entry) {
      const id = String(entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const atMs = Number(entry.atMs || Date.now());
      const payload = JSON.stringify({ ...entry, id, atMs });
      await client.execute({
        sql: `INSERT OR REPLACE INTO searches (id, at_ms, payload) VALUES (?, ?, ?)`,
        args: [id, atMs, payload],
      });
      // Cap table size.
      await client.execute({
        sql: `
          DELETE FROM searches WHERE id IN (
            SELECT id FROM searches ORDER BY at_ms DESC LIMIT -1 OFFSET ?
          )
        `,
        args: [MAX_HISTORY],
      });
    },
    async clear() {
      await client.execute(`DELETE FROM searches`);
    },
  };
}

/**
 * @returns {Promise<{ kind: string, list: Function, size: Function, push: Function, clear: Function }>}
 */
async function createHistoryStore(dataDir) {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
  if (url && authToken) {
    try {
      const store = await createTursoStore(url, authToken);
      console.log("History store: Turso (persistent)");
      return store;
    } catch (err) {
      console.error("Turso init failed — falling back to file:", err.message);
    }
  } else {
    console.log("History store: local file (ephemeral on Render Free)");
  }
  return createFileStore(dataDir);
}

module.exports = { createHistoryStore, MAX_HISTORY };
