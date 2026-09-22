/**
 * Device quota ledger + promo codes + purchases.
 * Turso when TURSO_* set, else Gist when GITHUB_TOKEN+BILLING_GIST_ID, else local JSON.
 */
const fs = require("fs");
const path = require("path");
const { loadGistJson, saveGistJson } = require("./gistStore");

const FREE_TRIAL_ANALYSES = 1000;
const SEED_PROMO = { code: "IYED", analyses: 1000, enabled: true };
const BILLING_GIST_FILE = "courseok-billing.json";

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function balanceOf(device) {
  const used = Number(device.used || 0);
  const quota = Number(device.quota || 0);
  return {
    used,
    quota,
    remaining: Math.max(0, quota - used),
  };
}

function createFileBillingStore(dataDir, gistOptions = null) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "billing.json");
  let gistSaveTimer = null;
  let gistBusy = Promise.resolve();

  function read() {
    try {
      if (!fs.existsSync(file)) {
        return { devices: {}, promos: {}, redemptions: [], purchases: [] };
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        devices: raw.devices && typeof raw.devices === "object" ? raw.devices : {},
        promos: raw.promos && typeof raw.promos === "object" ? raw.promos : {},
        redemptions: Array.isArray(raw.redemptions) ? raw.redemptions : [],
        purchases: Array.isArray(raw.purchases) ? raw.purchases : [],
      };
    } catch {
      return { devices: {}, promos: {}, redemptions: [], purchases: [] };
    }
  }

  function scheduleGistSave(snapshot) {
    if (!gistOptions?.token || !gistOptions?.gistId) return;
    if (gistSaveTimer) clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(() => {
      gistBusy = gistBusy
        .then(() =>
          saveGistJson(gistOptions.gistId, BILLING_GIST_FILE, gistOptions.token, snapshot),
        )
        .catch((err) => console.error("billing gist save failed:", err.message || err));
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
      const remote = await loadGistJson(gistOptions.gistId, BILLING_GIST_FILE, gistOptions.token);
      if (remote && typeof remote === "object") {
        state = {
          devices: remote.devices && typeof remote.devices === "object" ? remote.devices : {},
          promos: remote.promos && typeof remote.promos === "object" ? remote.promos : {},
          redemptions: Array.isArray(remote.redemptions) ? remote.redemptions : [],
          purchases: Array.isArray(remote.purchases) ? remote.purchases : [],
        };
        fs.writeFileSync(file, JSON.stringify(state, null, 2));
        console.log("Billing store hydrated from GitHub Gist");
      }
    } catch (err) {
      console.error("billing gist hydrate failed:", err.message || err);
    }
  }

  async function seedPromos() {
    if (!state.promos[SEED_PROMO.code]) {
      state.promos[SEED_PROMO.code] = {
        code: SEED_PROMO.code,
        analyses: SEED_PROMO.analyses,
        enabled: SEED_PROMO.enabled,
        createdAtMs: Date.now(),
      };
      write(state);
    }
  }

  return {
    kind: gistOptions?.gistId ? "gist" : "file",
    hydrateFromGist,
    seedPromos,

    async registerDevice(deviceId) {
      const id = String(deviceId || "").trim();
      if (!id) throw new Error("deviceId required");
      const now = Date.now();
      let device = state.devices[id];
      let created = false;
      if (!device) {
        device = {
          deviceId: id,
          used: 0,
          quota: FREE_TRIAL_ANALYSES,
          createdAtMs: now,
          updatedAtMs: now,
        };
        state.devices[id] = device;
        created = true;
        write(state);
      }
      return { ...balanceOf(device), created };
    },

    async getBalance(deviceId) {
      const id = String(deviceId || "").trim();
      const device = state.devices[id];
      if (!device) return null;
      return balanceOf(device);
    },

    async consume(deviceId) {
      const id = String(deviceId || "").trim();
      const device = state.devices[id];
      if (!device) return { ok: false, reason: "unknown_device" };
      if (device.used >= device.quota) {
        return { ok: false, reason: "no_credits", ...balanceOf(device) };
      }
      device.used += 1;
      device.updatedAtMs = Date.now();
      write(state);
      return { ok: true, ...balanceOf(device) };
    },

    async addQuota(deviceId, analyses) {
      const id = String(deviceId || "").trim();
      const n = Math.max(0, Number(analyses) || 0);
      let device = state.devices[id];
      const now = Date.now();
      if (!device) {
        device = {
          deviceId: id,
          used: 0,
          quota: FREE_TRIAL_ANALYSES + n,
          createdAtMs: now,
          updatedAtMs: now,
        };
        state.devices[id] = device;
      } else {
        device.quota += n;
        device.updatedAtMs = now;
      }
      write(state);
      return balanceOf(device);
    },

    async listPromos() {
      return Object.values(state.promos).sort((a, b) => a.code.localeCompare(b.code));
    },

    async upsertPromo(code, analyses, enabled = true) {
      const c = String(code || "").trim().toUpperCase();
      if (!c) throw new Error("code required");
      const n = Math.max(1, Number(analyses) || 0);
      const existing = state.promos[c];
      state.promos[c] = {
        code: c,
        analyses: n,
        enabled: Boolean(enabled),
        createdAtMs: existing?.createdAtMs || Date.now(),
      };
      write(state);
      return state.promos[c];
    },

    async deletePromo(code) {
      const c = String(code || "").trim().toUpperCase();
      if (!state.promos[c]) return false;
      delete state.promos[c];
      write(state);
      return true;
    },

    async redeemPromo(deviceId, code) {
      const id = String(deviceId || "").trim();
      const c = String(code || "").trim().toUpperCase();
      const promo = state.promos[c];
      if (!promo || !promo.enabled) {
        return { ok: false, reason: "invalid_code" };
      }
      await this.registerDevice(id);
      const balance = await this.addQuota(id, promo.analyses);
      const redemption = {
        id: newId(),
        deviceId: id,
        code: c,
        analyses: promo.analyses,
        atMs: Date.now(),
      };
      state.redemptions.unshift(redemption);
      if (state.redemptions.length > 5000) state.redemptions.length = 5000;
      write(state);
      return { ok: true, analysesAdded: promo.analyses, ...balance };
    },

    async createPurchase(entry) {
      const purchase = {
        id: entry.id || newId(),
        deviceId: entry.deviceId,
        packId: entry.packId,
        analyses: entry.analyses,
        amountCents: entry.amountCents,
        sumupCheckoutId: entry.sumupCheckoutId || null,
        status: entry.status || "pending",
        atMs: entry.atMs || Date.now(),
      };
      state.purchases.unshift(purchase);
      if (state.purchases.length > 5000) state.purchases.length = 5000;
      write(state);
      return purchase;
    },

    async getPurchase(purchaseId) {
      return state.purchases.find((p) => p.id === purchaseId) || null;
    },

    async getPurchaseByCheckoutId(checkoutId) {
      return state.purchases.find((p) => p.sumupCheckoutId === checkoutId) || null;
    },

    async markPurchasePaid(purchaseId) {
      const purchase = state.purchases.find((p) => p.id === purchaseId);
      if (!purchase) return { ok: false, reason: "not_found" };
      if (purchase.status === "paid") {
        const balance = await this.getBalance(purchase.deviceId);
        return { ok: true, alreadyPaid: true, purchase, balance };
      }
      purchase.status = "paid";
      const balance = await this.addQuota(purchase.deviceId, purchase.analyses);
      write(state);
      return { ok: true, alreadyPaid: false, purchase, balance };
    },

    async updatePurchaseCheckoutId(purchaseId, checkoutId) {
      const purchase = state.purchases.find((p) => p.id === purchaseId);
      if (!purchase) return null;
      purchase.sumupCheckoutId = checkoutId;
      write(state);
      return purchase;
    },
  };
}

async function createTursoBillingStore(url, authToken) {
  const { createClient } = require("@libsql/client");
  const client = createClient({ url, authToken });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      used INTEGER NOT NULL DEFAULT 0,
      quota INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      analyses INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      code TEXT NOT NULL,
      analyses INTEGER NOT NULL,
      at_ms INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      analyses INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      sumup_checkout_id TEXT,
      status TEXT NOT NULL,
      at_ms INTEGER NOT NULL
    )
  `);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_purchases_checkout ON purchases(sumup_checkout_id)`,
  );

  async function seedPromos() {
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO promo_codes (code, analyses, enabled, created_at_ms)
        VALUES (?, ?, 1, ?)
      `,
      args: [SEED_PROMO.code, SEED_PROMO.analyses, Date.now()],
    });
  }

  async function loadDevice(deviceId) {
    const rs = await client.execute({
      sql: `SELECT device_id, used, quota, created_at_ms, updated_at_ms FROM devices WHERE device_id = ?`,
      args: [deviceId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      deviceId: row.device_id,
      used: Number(row.used),
      quota: Number(row.quota),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  return {
    kind: "turso",
    seedPromos,

    async registerDevice(deviceId) {
      const id = String(deviceId || "").trim();
      if (!id) throw new Error("deviceId required");
      const existing = await loadDevice(id);
      if (existing) return { ...balanceOf(existing), created: false };
      const now = Date.now();
      await client.execute({
        sql: `
          INSERT INTO devices (device_id, used, quota, created_at_ms, updated_at_ms)
          VALUES (?, 0, ?, ?, ?)
        `,
        args: [id, FREE_TRIAL_ANALYSES, now, now],
      });
      return { used: 0, quota: FREE_TRIAL_ANALYSES, remaining: FREE_TRIAL_ANALYSES, created: true };
    },

    async getBalance(deviceId) {
      const device = await loadDevice(String(deviceId || "").trim());
      if (!device) return null;
      return balanceOf(device);
    },

    async consume(deviceId) {
      const id = String(deviceId || "").trim();
      const device = await loadDevice(id);
      if (!device) return { ok: false, reason: "unknown_device" };
      if (device.used >= device.quota) {
        return { ok: false, reason: "no_credits", ...balanceOf(device) };
      }
      const now = Date.now();
      const rs = await client.execute({
        sql: `
          UPDATE devices
          SET used = used + 1, updated_at_ms = ?
          WHERE device_id = ? AND used < quota
        `,
        args: [now, id],
      });
      if (Number(rs.rowsAffected || 0) === 0) {
        const again = await loadDevice(id);
        return { ok: false, reason: "no_credits", ...balanceOf(again || device) };
      }
      const updated = await loadDevice(id);
      return { ok: true, ...balanceOf(updated) };
    },

    async addQuota(deviceId, analyses) {
      const id = String(deviceId || "").trim();
      const n = Math.max(0, Number(analyses) || 0);
      const now = Date.now();
      const existing = await loadDevice(id);
      if (!existing) {
        await client.execute({
          sql: `
            INSERT INTO devices (device_id, used, quota, created_at_ms, updated_at_ms)
            VALUES (?, 0, ?, ?, ?)
          `,
          args: [id, FREE_TRIAL_ANALYSES + n, now, now],
        });
      } else {
        await client.execute({
          sql: `UPDATE devices SET quota = quota + ?, updated_at_ms = ? WHERE device_id = ?`,
          args: [n, now, id],
        });
      }
      return balanceOf(await loadDevice(id));
    },

    async listPromos() {
      const rs = await client.execute(
        `SELECT code, analyses, enabled, created_at_ms FROM promo_codes ORDER BY code ASC`,
      );
      return rs.rows.map((row) => ({
        code: row.code,
        analyses: Number(row.analyses),
        enabled: Boolean(Number(row.enabled)),
        createdAtMs: Number(row.created_at_ms),
      }));
    },

    async upsertPromo(code, analyses, enabled = true) {
      const c = String(code || "").trim().toUpperCase();
      if (!c) throw new Error("code required");
      const n = Math.max(1, Number(analyses) || 0);
      const existing = await client.execute({
        sql: `SELECT created_at_ms FROM promo_codes WHERE code = ?`,
        args: [c],
      });
      const createdAt = existing.rows[0]
        ? Number(existing.rows[0].created_at_ms)
        : Date.now();
      await client.execute({
        sql: `
          INSERT OR REPLACE INTO promo_codes (code, analyses, enabled, created_at_ms)
          VALUES (?, ?, ?, ?)
        `,
        args: [c, n, enabled ? 1 : 0, createdAt],
      });
      return { code: c, analyses: n, enabled: Boolean(enabled), createdAtMs: createdAt };
    },

    async deletePromo(code) {
      const c = String(code || "").trim().toUpperCase();
      const rs = await client.execute({
        sql: `DELETE FROM promo_codes WHERE code = ?`,
        args: [c],
      });
      return Number(rs.rowsAffected || 0) > 0;
    },

    async redeemPromo(deviceId, code) {
      const id = String(deviceId || "").trim();
      const c = String(code || "").trim().toUpperCase();
      const rs = await client.execute({
        sql: `SELECT code, analyses, enabled FROM promo_codes WHERE code = ?`,
        args: [c],
      });
      const row = rs.rows[0];
      if (!row || !Number(row.enabled)) {
        return { ok: false, reason: "invalid_code" };
      }
      const analyses = Number(row.analyses);
      await this.registerDevice(id);
      const balance = await this.addQuota(id, analyses);
      await client.execute({
        sql: `
          INSERT INTO promo_redemptions (id, device_id, code, analyses, at_ms)
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [newId(), id, c, analyses, Date.now()],
      });
      return { ok: true, analysesAdded: analyses, ...balance };
    },

    async createPurchase(entry) {
      const purchase = {
        id: entry.id || newId(),
        deviceId: entry.deviceId,
        packId: entry.packId,
        analyses: entry.analyses,
        amountCents: entry.amountCents,
        sumupCheckoutId: entry.sumupCheckoutId || null,
        status: entry.status || "pending",
        atMs: entry.atMs || Date.now(),
      };
      await client.execute({
        sql: `
          INSERT INTO purchases
            (id, device_id, pack_id, analyses, amount_cents, sumup_checkout_id, status, at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          purchase.id,
          purchase.deviceId,
          purchase.packId,
          purchase.analyses,
          purchase.amountCents,
          purchase.sumupCheckoutId,
          purchase.status,
          purchase.atMs,
        ],
      });
      return purchase;
    },

    async getPurchase(purchaseId) {
      const rs = await client.execute({
        sql: `SELECT * FROM purchases WHERE id = ?`,
        args: [purchaseId],
      });
      const row = rs.rows[0];
      if (!row) return null;
      return rowToPurchase(row);
    },

    async getPurchaseByCheckoutId(checkoutId) {
      const rs = await client.execute({
        sql: `SELECT * FROM purchases WHERE sumup_checkout_id = ?`,
        args: [checkoutId],
      });
      const row = rs.rows[0];
      if (!row) return null;
      return rowToPurchase(row);
    },

    async markPurchasePaid(purchaseId) {
      const purchase = await this.getPurchase(purchaseId);
      if (!purchase) return { ok: false, reason: "not_found" };
      if (purchase.status === "paid") {
        const balance = await this.getBalance(purchase.deviceId);
        return { ok: true, alreadyPaid: true, purchase, balance };
      }
      await client.execute({
        sql: `UPDATE purchases SET status = 'paid' WHERE id = ? AND status != 'paid'`,
        args: [purchaseId],
      });
      const balance = await this.addQuota(purchase.deviceId, purchase.analyses);
      const updated = await this.getPurchase(purchaseId);
      return { ok: true, alreadyPaid: false, purchase: updated, balance };
    },

    async updatePurchaseCheckoutId(purchaseId, checkoutId) {
      await client.execute({
        sql: `UPDATE purchases SET sumup_checkout_id = ? WHERE id = ?`,
        args: [checkoutId, purchaseId],
      });
      return this.getPurchase(purchaseId);
    },
  };
}

function rowToPurchase(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    packId: row.pack_id,
    analyses: Number(row.analyses),
    amountCents: Number(row.amount_cents),
    sumupCheckoutId: row.sumup_checkout_id || null,
    status: row.status,
    atMs: Number(row.at_ms),
  };
}

/**
 * @returns {Promise<object>}
 */
async function createBillingStore(dataDir) {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
  if (url && authToken) {
    try {
      const store = await createTursoBillingStore(url, authToken);
      await store.seedPromos();
      console.log("Billing store: Turso (persistent)");
      return store;
    } catch (err) {
      console.error("Turso billing init failed — falling back:", err.message);
    }
  }

  const gistId = (process.env.BILLING_GIST_ID || "").trim();
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  const gistOptions = gistId && ghToken ? { gistId, token: ghToken } : null;
  if (gistOptions) {
    console.log("Billing store: GitHub Gist (persistent)");
  } else {
    console.log("Billing store: local file");
  }
  const store = createFileBillingStore(dataDir, gistOptions);
  if (store.hydrateFromGist) await store.hydrateFromGist();
  await store.seedPromos();
  return store;
}

module.exports = { createBillingStore, FREE_TRIAL_ANALYSES };
