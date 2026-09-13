/**
 * Persistent search history:
 * - Turso when TURSO_* set
 * - GitHub Gist when GITHUB_TOKEN + HISTORY_GIST_ID (survives Render Free wipe)
 * - Local JSON otherwise (dev)
 */
const fs = require("fs");
const path = require("path");
const { loadGistJson, saveGistJson } = require("./gistStore");

const MAX_HISTORY = 500;
const HISTORY_GIST_FILE = "courseok-searches.json";

function createFileStore(dataDir, gistOptions = null) {
  const historyFile = path.join(dataDir, "searches.json");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  let gistSaveTimer = null;

  function read() {
    try {
      if (!fs.existsSync(historyFile)) return [];
      const raw = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function scheduleGistSave(items) {
    if (!gistOptions?.token || !gistOptions?.gistId) return;
    if (gistSaveTimer) clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(() => {
      saveGistJson(gistOptions.gistId, HISTORY_GIST_FILE, gistOptions.token, items).catch(
        (err) => console.error("history gist save failed:", err.message || err),
      );
    }, 400);
  }

  function write(items) {
    const capped = items.slice(0, MAX_HISTORY);
    fs.writeFileSync(historyFile, JSON.stringify(capped, null, 2));
    scheduleGistSave(capped);
  }

  let cache = read();

  async function hydrateFromGist() {
    if (!gistOptions?.token || !gistOptions?.gistId) return;
    try {
      const remote = await loadGistJson(gistOptions.gistId, HISTORY_GIST_FILE, gistOptions.token);
      if (Array.isArray(remote)) {
        cache = remote.slice(0, MAX_HISTORY);
        fs.writeFileSync(historyFile, JSON.stringify(cache, null, 2));
        console.log("History store hydrated from GitHub Gist (", cache.length, "items)");
      }
    } catch (err) {
      console.error("history gist hydrate failed:", err.message || err);
    }
  }

  return {
    kind: gistOptions?.gistId ? "gist" : "file",
    hydrateFromGist,
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

async function createHistoryStore(dataDir) {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
  if (url && authToken) {
    try {
      const store = await createTursoStore(url, authToken);
      console.log("History store: Turso (persistent)");
      return store;
    } catch (err) {
      console.error("Turso init failed — falling back:", err.message);
    }
  }

  const gistId = (process.env.HISTORY_GIST_ID || "").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const gistOptions = gistId && ghToken ? { gistId, token: ghToken } : null;
  if (gistOptions) {
    console.log("History store: GitHub Gist (persistent)");
  } else {
    console.log("History store: local file (ephemeral on Render Free)");
  }
  const store = createFileStore(dataDir, gistOptions);
  if (store.hydrateFromGist) await store.hydrateFromGist();
  return store;
}

module.exports = { createHistoryStore, MAX_HISTORY };
