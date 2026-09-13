/**
 * Durable shared route-duration cache (survives Render Free restarts via Gist).
 */
const fs = require("fs");
const path = require("path");
const { loadGistJson, saveGistJson } = require("./gistStore");

const ROUTES_GIST_FILE = "courseok-routes.json";
const MAX_ENTRIES = 8000;

function createRouteCacheStore(dataDir, ttlMs) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "routes-cache.json");
  const gistId = (process.env.ROUTES_GIST_ID || "").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const gistOptions = gistId && ghToken ? { gistId, token: ghToken } : null;
  let gistSaveTimer = null;
  /** @type {Map<string, object>} */
  const map = new Map();

  function readLocal() {
    try {
      if (!fs.existsSync(file)) return {};
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object"
        ? raw.entries
        : {};
    } catch {
      return {};
    }
  }

  function snapshot() {
    const entries = {};
    for (const [k, v] of map.entries()) entries[k] = v;
    return { entries, updatedAtMs: Date.now() };
  }

  function scheduleGistSave() {
    if (!gistOptions) return;
    if (gistSaveTimer) clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(() => {
      const data = snapshot();
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      saveGistJson(gistOptions.gistId, ROUTES_GIST_FILE, gistOptions.token, data).catch(
        (err) => console.error("routes gist save failed:", err.message || err),
      );
    }, 800);
  }

  function writeLocal() {
    fs.writeFileSync(file, JSON.stringify(snapshot(), null, 2));
    scheduleGistSave();
  }

  function loadEntries(entries) {
    map.clear();
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries || {})) {
      if (!entry || typeof entry !== "object") continue;
      const age = now - Number(entry.cachedAtMs || 0);
      if (age > ttlMs) continue;
      map.set(key, entry);
    }
  }

  loadEntries(readLocal());

  return {
    kind: gistOptions ? "gist" : "file",
    size() {
      return map.size;
    },
    get(key) {
      return map.get(key) || null;
    },
    set(key, entry) {
      map.set(key, entry);
      // Cap size: drop oldest by cachedAtMs.
      if (map.size > MAX_ENTRIES) {
        const sorted = [...map.entries()].sort(
          (a, b) => Number(a[1].cachedAtMs || 0) - Number(b[1].cachedAtMs || 0),
        );
        const toDrop = map.size - MAX_ENTRIES;
        for (let i = 0; i < toDrop; i++) map.delete(sorted[i][0]);
      }
      writeLocal();
    },
    prune(now = Date.now()) {
      let removed = 0;
      for (const [key, entry] of map.entries()) {
        if (now - Number(entry.cachedAtMs || 0) > ttlMs) {
          map.delete(key);
          removed += 1;
        }
      }
      if (removed > 0) writeLocal();
      return removed;
    },
    async hydrateFromGist() {
      if (!gistOptions) return;
      try {
        const remote = await loadGistJson(gistOptions.gistId, ROUTES_GIST_FILE, gistOptions.token);
        if (remote?.entries && typeof remote.entries === "object") {
          loadEntries(remote.entries);
          fs.writeFileSync(file, JSON.stringify(snapshot(), null, 2));
          console.log("Route cache hydrated from Gist (", map.size, "entries)");
        }
      } catch (err) {
        console.error("routes gist hydrate failed:", err.message || err);
      }
    },
  };
}

module.exports = { createRouteCacheStore };
