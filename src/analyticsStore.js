/**
 * Funnel analytics: APK downloads + device install / permissions / activity.
 * Uninstall is approximated via inactivity (Android cannot notify sideloaded apps).
 * Turso when TURSO_* set, else Gist when GITHUB_TOKEN+ANALYTICS_GIST_ID, else local JSON.
 */
const fs = require("fs");
const path = require("path");
const { loadGistJson, saveGistJson } = require("./gistStore");

const INACTIVE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days ≈ likely gone
const ACTIVE_7D_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_24H_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_GIST_FILE = "courseok-analytics.json";

function emptyState() {
  return { downloads: 0, devices: {} };
}

function normalizePerms(p) {
  const src = p && typeof p === "object" ? p : {};
  return {
    accessibility: Boolean(src.accessibility),
    location: Boolean(src.location),
    notifications: Boolean(src.notifications),
    battery: Boolean(src.battery),
  };
}

function clip(s, max = 48) {
  const t = String(s || "").trim();
  if (!t) return null;
  return t.slice(0, max);
}

function normalizeEmail(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t || t.length > 120) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return null;
  return t;
}

/** manufacturer / brand / model / android from app ping. */
function normalizeDeviceInfo(raw) {
  const src =
    raw && typeof raw === "object"
      ? raw
      : {};
  // Also accept flat fields on the ping body for older callers.
  const manufacturer = clip(src.manufacturer);
  const brand = clip(src.brand);
  const model = clip(src.model);
  const android = clip(src.android || src.release, 16);
  const sdkRaw = src.sdk ?? src.sdkInt;
  const sdk =
    sdkRaw == null || sdkRaw === ""
      ? null
      : Math.max(0, Math.min(99, Number(sdkRaw) || 0)) || null;
  if (!manufacturer && !brand && !model && !android && sdk == null) return null;
  return { manufacturer, brand, model, android, sdk };
}

function deviceLabel(info) {
  if (!info) return null;
  const brand = info.brand || info.manufacturer;
  const model = info.model;
  if (brand && model) {
    const b = brand.toLowerCase();
    const m = model.toLowerCase();
    // Avoid "Samsung SM-…" → "Samsung Samsung…" when model already starts with brand
    if (m.startsWith(b)) return model;
    return `${brand} ${model}`;
  }
  return model || brand || info.manufacturer || null;
}

function summarize(state, now = Date.now()) {
  const devices = Object.values(state.devices || {});
  let permissionsGranted = 0;
  let activeLast24h = 0;
  let activeLast7d = 0;
  let likelyUninstalled = 0;
  let installedNeverPerms = 0;

  for (const d of devices) {
    const last = Number(d.lastSeenMs || d.firstSeenMs || 0);
    const age = now - last;
    if (d.permissionsOk) permissionsGranted += 1;
    if (age <= ACTIVE_24H_MS) activeLast24h += 1;
    if (age <= ACTIVE_7D_MS) activeLast7d += 1;
    if (d.permissionsOk && age > INACTIVE_MS) likelyUninstalled += 1;
    if (!d.permissionsOk && age > INACTIVE_MS) installedNeverPerms += 1;
  }

  const recent = devices
    .slice()
    .sort((a, b) => Number(b.lastSeenMs || 0) - Number(a.lastSeenMs || 0))
    .slice(0, 100)
    .map((d) => {
      const info = d.deviceInfo || null;
      return {
        deviceId: d.deviceId,
        firstSeenMs: d.firstSeenMs,
        lastSeenMs: d.lastSeenMs,
        permissionsOk: Boolean(d.permissionsOk),
        permissionsOkAtMs: d.permissionsOkAtMs || null,
        appVersion: d.appVersion || null,
        permissions: d.permissions || null,
        deviceInfo: info,
        deviceLabel: deviceLabel(info),
        accountEmail: d.accountEmail || null,
        inactiveDays: Math.floor(
          (now - Number(d.lastSeenMs || d.firstSeenMs || now)) / (24 * 60 * 60 * 1000),
        ),
      };
    });

  return {
    downloads: Number(state.downloads || 0),
    installs: devices.length,
    permissionsGranted,
    activeLast24h,
    activeLast7d,
    likelyUninstalled,
    installedNeverPerms,
    inactiveAfterDays: Math.round(INACTIVE_MS / (24 * 60 * 60 * 1000)),
    devices: recent,
  };
}

function applyPing(state, payload) {
  const id = String(payload.deviceId || "").trim();
  if (!id) throw new Error("deviceId required");
  const now = Date.now();
  const perms = normalizePerms(payload.permissions);
  const allGranted =
    payload.allGranted === true ||
    (perms.accessibility && perms.location && perms.notifications && perms.battery);
  const info =
    normalizeDeviceInfo(payload.device) ||
    normalizeDeviceInfo(payload);
  const accountEmail = normalizeEmail(payload.accountEmail || payload.email);

  let device = state.devices[id];
  if (!device) {
    device = {
      deviceId: id,
      firstSeenMs: now,
      lastSeenMs: now,
      permissionsOk: false,
      permissionsOkAtMs: null,
      appVersion: null,
      permissions: perms,
      deviceInfo: info,
      accountEmail: accountEmail,
    };
    state.devices[id] = device;
  }
  device.lastSeenMs = now;
  device.permissions = perms;
  if (payload.appVersion) device.appVersion = String(payload.appVersion).slice(0, 32);
  if (info) device.deviceInfo = info;
  if (accountEmail) device.accountEmail = accountEmail;
  if (allGranted) {
    if (!device.permissionsOk) {
      device.permissionsOk = true;
      device.permissionsOkAtMs = now;
    }
  } else {
    // Keep historical "ever granted" for funnel; only flip off if explicitly lost after having been ok
    // We still track current snapshot in permissions.*
    // permissionsOk stays true once achieved (conversion metric).
  }
  return device;
}

function createFileAnalyticsStore(dataDir, gistOptions = null) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "analytics.json");
  let gistSaveTimer = null;

  function read() {
    try {
      if (!fs.existsSync(file)) return emptyState();
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        downloads: Number(raw.downloads || 0),
        devices: raw.devices && typeof raw.devices === "object" ? raw.devices : {},
      };
    } catch {
      return emptyState();
    }
  }

  function scheduleGistSave(snapshot) {
    if (!gistOptions?.token || !gistOptions?.gistId) return;
    if (gistSaveTimer) clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(() => {
      saveGistJson(gistOptions.gistId, ANALYTICS_GIST_FILE, gistOptions.token, snapshot).catch(
        (err) => console.error("analytics gist save failed:", err.message || err),
      );
    }, 400);
  }

  function write(state) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    scheduleGistSave(state);
  }

  let state = read();

  async function hydrateFromGist() {
    if (!gistOptions?.token || !gistOptions?.gistId) return;
    try {
      const remote = await loadGistJson(gistOptions.gistId, ANALYTICS_GIST_FILE, gistOptions.token);
      if (remote && typeof remote === "object") {
        state = {
          downloads: Number(remote.downloads || 0),
          devices: remote.devices && typeof remote.devices === "object" ? remote.devices : {},
        };
        fs.writeFileSync(file, JSON.stringify(state, null, 2));
        console.log("Analytics store hydrated from GitHub Gist");
      }
    } catch (err) {
      console.error("analytics gist hydrate failed:", err.message || err);
    }
  }

  return {
    kind: gistOptions?.gistId ? "gist" : "file",
    hydrateFromGist,

    async incrementDownloads() {
      state.downloads = Number(state.downloads || 0) + 1;
      write(state);
      return state.downloads;
    },

    async recordPing(payload) {
      const device = applyPing(state, payload);
      write(state);
      return { ok: true, deviceId: device.deviceId, permissionsOk: device.permissionsOk };
    },

    async summary() {
      return summarize(state);
    },
  };
}

async function createTursoAnalyticsStore(url, authToken) {
  const { createClient } = require("@libsql/client");
  const client = createClient({ url, authToken });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS analytics_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS analytics_devices (
      device_id TEXT PRIMARY KEY,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      permissions_ok INTEGER NOT NULL DEFAULT 0,
      permissions_ok_at_ms INTEGER,
      app_version TEXT,
      accessibility INTEGER NOT NULL DEFAULT 0,
      location INTEGER NOT NULL DEFAULT 0,
      notifications INTEGER NOT NULL DEFAULT 0,
      battery INTEGER NOT NULL DEFAULT 0,
      device_info_json TEXT
    )
  `);
  // Migrate older schemas that lack device_info_json / account_email.
  await client.execute(`ALTER TABLE analytics_devices ADD COLUMN device_info_json TEXT`).catch(() => {});
  await client.execute(`ALTER TABLE analytics_devices ADD COLUMN account_email TEXT`).catch(() => {});
  await client.execute(
    `INSERT OR IGNORE INTO analytics_meta (key, value) VALUES ('downloads', 0)`,
  );

  async function loadAllDevices() {
    const rs = await client.execute(`SELECT * FROM analytics_devices`);
    const devices = {};
    for (const row of rs.rows) {
      const id = String(row.device_id);
      let deviceInfo = null;
      if (row.device_info_json) {
        try {
          deviceInfo = normalizeDeviceInfo(JSON.parse(String(row.device_info_json)));
        } catch {
          deviceInfo = null;
        }
      }
      devices[id] = {
        deviceId: id,
        firstSeenMs: Number(row.first_seen_ms),
        lastSeenMs: Number(row.last_seen_ms),
        permissionsOk: Boolean(Number(row.permissions_ok)),
        permissionsOkAtMs: row.permissions_ok_at_ms != null ? Number(row.permissions_ok_at_ms) : null,
        appVersion: row.app_version || null,
        permissions: {
          accessibility: Boolean(Number(row.accessibility)),
          location: Boolean(Number(row.location)),
          notifications: Boolean(Number(row.notifications)),
          battery: Boolean(Number(row.battery)),
        },
        deviceInfo,
        accountEmail: row.account_email || null,
      };
    }
    return devices;
  }

  return {
    kind: "turso",

    async incrementDownloads() {
      await client.execute(
        `UPDATE analytics_meta SET value = value + 1 WHERE key = 'downloads'`,
      );
      const rs = await client.execute(
        `SELECT value FROM analytics_meta WHERE key = 'downloads'`,
      );
      return Number(rs.rows[0]?.value || 0);
    },

    async recordPing(payload) {
      const id = String(payload.deviceId || "").trim();
      if (!id) throw new Error("deviceId required");
      const now = Date.now();
      const perms = normalizePerms(payload.permissions);
      const allGranted =
        payload.allGranted === true ||
        (perms.accessibility && perms.location && perms.notifications && perms.battery);
      const appVersion = payload.appVersion ? String(payload.appVersion).slice(0, 32) : null;
      const info =
        normalizeDeviceInfo(payload.device) ||
        normalizeDeviceInfo(payload);
      const infoJson = info ? JSON.stringify(info) : null;
      const accountEmail = normalizeEmail(payload.accountEmail || payload.email);

      const existing = await client.execute({
        sql: `SELECT permissions_ok, permissions_ok_at_ms, first_seen_ms FROM analytics_devices WHERE device_id = ?`,
        args: [id],
      });
      const row = existing.rows[0];
      let permissionsOk = allGranted;
      let permissionsOkAt = allGranted ? now : null;
      if (row) {
        const wasOk = Boolean(Number(row.permissions_ok));
        permissionsOk = wasOk || allGranted;
        permissionsOkAt = wasOk
          ? row.permissions_ok_at_ms != null
            ? Number(row.permissions_ok_at_ms)
            : null
          : allGranted
            ? now
            : null;
        await client.execute({
          sql: `
            UPDATE analytics_devices SET
              last_seen_ms = ?,
              permissions_ok = ?,
              permissions_ok_at_ms = ?,
              app_version = COALESCE(?, app_version),
              accessibility = ?,
              location = ?,
              notifications = ?,
              battery = ?,
              device_info_json = COALESCE(?, device_info_json),
              account_email = COALESCE(?, account_email)
            WHERE device_id = ?
          `,
          args: [
            now,
            permissionsOk ? 1 : 0,
            permissionsOkAt,
            appVersion,
            perms.accessibility ? 1 : 0,
            perms.location ? 1 : 0,
            perms.notifications ? 1 : 0,
            perms.battery ? 1 : 0,
            infoJson,
            accountEmail,
            id,
          ],
        });
      } else {
        await client.execute({
          sql: `
            INSERT INTO analytics_devices (
              device_id, first_seen_ms, last_seen_ms, permissions_ok, permissions_ok_at_ms,
              app_version, accessibility, location, notifications, battery, device_info_json,
              account_email
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            id,
            now,
            now,
            permissionsOk ? 1 : 0,
            permissionsOkAt,
            appVersion,
            perms.accessibility ? 1 : 0,
            perms.location ? 1 : 0,
            perms.notifications ? 1 : 0,
            perms.battery ? 1 : 0,
            infoJson,
            accountEmail,
          ],
        });
      }
      return { ok: true, deviceId: id, permissionsOk };
    },

    async summary() {
      const dl = await client.execute(
        `SELECT value FROM analytics_meta WHERE key = 'downloads'`,
      );
      const devices = await loadAllDevices();
      return summarize({
        downloads: Number(dl.rows[0]?.value || 0),
        devices,
      });
    },
  };
}

async function createAnalyticsStore(dataDir) {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
  if (url && authToken) {
    try {
      const store = await createTursoAnalyticsStore(url, authToken);
      console.log("Analytics store: Turso (persistent)");
      return store;
    } catch (err) {
      console.error("Turso analytics init failed — falling back:", err.message);
    }
  }

  const gistId = (process.env.ANALYTICS_GIST_ID || "").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const gistOptions = gistId && ghToken ? { gistId, token: ghToken } : null;
  if (gistOptions) {
    console.log("Analytics store: GitHub Gist (persistent)");
  } else {
    console.log("Analytics store: local file");
  }
  const store = createFileAnalyticsStore(dataDir, gistOptions);
  if (store.hydrateFromGist) await store.hydrateFromGist();
  return store;
}

module.exports = { createAnalyticsStore, INACTIVE_MS };
