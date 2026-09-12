/**
 * CourseOK route backend — shared Google Routes/Geocode cache (15 min) + billing ledger.
 * Keep secrets in .env / Render env only (never commit).
 *
 * History / billing persistence:
 * - TURSO_DATABASE_URL + TURSO_AUTH_TOKEN → free durable Turso DB (survives Render sleep)
 * - else → local data/*.json (wiped on Render Free restart)
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const { createHistoryStore, MAX_HISTORY } = require("./historyStore");
const { createBillingStore, FREE_TRIAL_ANALYSES } = require("./billingStore");
const { PACKS, getPack } = require("./packs");

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const SUMUP_API_KEY = (process.env.SUMUP_API_KEY || "").trim();
const SUMUP_MERCHANT_CODE = (process.env.SUMUP_MERCHANT_CODE || "").trim();
const SUMUP_WEBHOOK_SECRET = (process.env.SUMUP_WEBHOOK_SECRET || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
const APK_DOWNLOAD_URL = (process.env.APK_DOWNLOAD_URL || "").trim();
const DATA_DIR = path.join(__dirname, "..", "data");
const SUMUP_API = "https://api.sumup.com/v0.1";

/** @type {Map<string, { durationMinutes: number, distanceMeters: number|null, cachedAtMs: number, pickup: string, dropoff: string }>} */
const routeCache = new Map();

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function normalizeAddress(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function routeKey(pickup, dropoff) {
  return `${normalizeAddress(pickup)}|${normalizeAddress(dropoff)}`;
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of routeCache.entries()) {
    if (now - entry.cachedAtMs > CACHE_TTL_MS) routeCache.delete(key);
  }
}

function requireAdmin(req, res) {
  if (ADMIN_TOKEN && req.header("x-admin-token") !== ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function requireDeviceId(bodyOrQuery) {
  const deviceId = String(bodyOrQuery?.deviceId || "").trim();
  return deviceId || null;
}

async function geocode(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", GOOGLE_MAPS_API_KEY);
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "OK" || !json.results?.[0]) {
    throw new Error(`Geocode failed: ${json.status || res.status} ${json.error_message || ""}`.trim());
  }
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: json.results[0].formatted_address || address };
}

async function computeRoute(origin, destination) {
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    languageCode: "fr",
  };
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Routes failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  const route = json.routes?.[0];
  if (!route?.duration) throw new Error("Routes failed: empty routes");
  const match = String(route.duration).match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) throw new Error(`Routes failed: bad duration ${route.duration}`);
  return {
    durationMinutes: Number(match[1]) / 60,
    distanceMeters: typeof route.distanceMeters === "number" ? route.distanceMeters : null,
  };
}

async function sumupCreateCheckout({ checkoutReference, amountEuros, description, redirectUrl }) {
  if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
    throw new Error("SUMUP_API_KEY / SUMUP_MERCHANT_CODE not configured");
  }
  const body = {
    checkout_reference: checkoutReference,
    amount: Number(amountEuros),
    currency: "EUR",
    merchant_code: SUMUP_MERCHANT_CODE,
    description: description.slice(0, 128),
    redirect_url: redirectUrl,
    hosted_checkout: { enabled: true },
  };
  const res = await fetch(`${SUMUP_API}/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUMUP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SumUp checkout failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function sumupGetCheckout(checkoutId) {
  if (!SUMUP_API_KEY) throw new Error("SUMUP_API_KEY not configured");
  const res = await fetch(`${SUMUP_API}/checkouts/${encodeURIComponent(checkoutId)}`, {
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SumUp get checkout failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function isSumupPaid(checkout) {
  const status = String(checkout?.status || "").toUpperCase();
  return status === "PAID";
}

async function main() {
  const history = await createHistoryStore(DATA_DIR);
  const billing = await createBillingStore(DATA_DIR);

  app.get("/api/health", async (_req, res) => {
    pruneCache();
    res.json({
      ok: true,
      hasMapsKey: Boolean(GOOGLE_MAPS_API_KEY),
      hasSumUp: Boolean(SUMUP_API_KEY && SUMUP_MERCHANT_CODE),
      hasApkDownload: Boolean(APK_DOWNLOAD_URL),
      freeTrialAnalyses: FREE_TRIAL_ANALYSES,
      cacheSize: routeCache.size,
      historySize: await history.size(),
      historyStore: history.kind,
      billingStore: billing.kind,
      cacheTtlMs: CACHE_TTL_MS,
    });
  });

  /** Neutral public APK link (hides upstream hosting URL from the landing page). */
  app.get(["/downloads/CourseOK-latest.apk", "/api/download-apk"], (_req, res) => {
    if (!APK_DOWNLOAD_URL) {
      return res.status(404).type("text").send("APK not configured");
    }
    res.redirect(302, APK_DOWNLOAD_URL);
  });

  app.get("/api/billing/packs", (_req, res) => {
    res.json({ packs: PACKS });
  });

  app.post("/api/billing/register", async (req, res) => {
    const deviceId = requireDeviceId(req.body);
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      const balance = await billing.registerDevice(deviceId);
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get("/api/billing/balance", async (req, res) => {
    const deviceId = requireDeviceId(req.query);
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      let balance = await billing.getBalance(deviceId);
      if (!balance) {
        balance = await billing.registerDevice(deviceId);
      }
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/billing/consume", async (req, res) => {
    const deviceId = requireDeviceId(req.body);
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      let existing = await billing.getBalance(deviceId);
      if (!existing) {
        await billing.registerDevice(deviceId);
      }
      const result = await billing.consume(deviceId);
      if (!result.ok) {
        return res.status(402).json({
          error: result.reason || "no_credits",
          used: result.used ?? 0,
          quota: result.quota ?? 0,
          remaining: result.remaining ?? 0,
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/billing/promo", async (req, res) => {
    const deviceId = requireDeviceId(req.body);
    const code = String(req.body?.code || "").trim();
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    if (!code) return res.status(400).json({ error: "code required" });
    try {
      const result = await billing.redeemPromo(deviceId, code);
      if (!result.ok) {
        return res.status(400).json({ error: result.reason || "invalid_code" });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/billing/checkout", async (req, res) => {
    const deviceId = requireDeviceId(req.body);
    const packId = String(req.body?.packId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const pack = getPack(packId);
    if (!pack) return res.status(400).json({ error: "invalid packId" });
    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
      return res.status(503).json({ error: "SumUp not configured on server" });
    }
    try {
      await billing.registerDevice(deviceId);
      const purchase = await billing.createPurchase({
        deviceId,
        packId: pack.id,
        analyses: pack.analyses,
        amountCents: pack.amountCents,
        status: "pending",
      });
      const redirectUrl = "courseok://billing/return";
      const checkout = await sumupCreateCheckout({
        checkoutReference: purchase.id,
        amountEuros: pack.priceEuros,
        description: `CourseOK — ${pack.label}`,
        redirectUrl,
      });
      const checkoutId = checkout.id || checkout.checkout_id || null;
      if (checkoutId) {
        await billing.updatePurchaseCheckoutId(purchase.id, String(checkoutId));
      }
      const checkoutUrl =
        checkout.hosted_checkout_url ||
        checkout.hosted_checkout?.url ||
        (checkoutId ? `https://pay.sumup.com/b2c/v2/checkouts/${checkoutId}` : null);
      if (!checkoutUrl) {
        return res.status(502).json({ error: "SumUp did not return a checkout URL", checkout });
      }
      res.json({
        purchaseId: purchase.id,
        checkoutId,
        checkoutUrl,
        pack,
      });
    } catch (err) {
      console.error("checkout error", err.message);
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  /** App calls after returning from SumUp (or on resume) to credit if PAID. */
  app.post("/api/billing/confirm", async (req, res) => {
    const purchaseId = String(req.body?.purchaseId || "").trim();
    if (!purchaseId) return res.status(400).json({ error: "purchaseId required" });
    try {
      const purchase = await billing.getPurchase(purchaseId);
      if (!purchase) return res.status(404).json({ error: "purchase not found" });
      if (purchase.status === "paid") {
        const balance = await billing.getBalance(purchase.deviceId);
        return res.json({ ok: true, alreadyPaid: true, purchase, balance });
      }
      if (!purchase.sumupCheckoutId) {
        return res.status(409).json({ error: "checkout not linked yet", purchase });
      }
      const checkout = await sumupGetCheckout(purchase.sumupCheckoutId);
      if (!isSumupPaid(checkout)) {
        return res.json({
          ok: false,
          status: checkout.status || "PENDING",
          purchase,
          balance: await billing.getBalance(purchase.deviceId),
        });
      }
      const result = await billing.markPurchasePaid(purchaseId);
      res.json(result);
    } catch (err) {
      console.error("confirm error", err.message);
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/billing/sumup-webhook", async (req, res) => {
    if (SUMUP_WEBHOOK_SECRET) {
      const secret = req.header("x-payload-signature") || req.header("x-sumup-secret") || "";
      if (secret !== SUMUP_WEBHOOK_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }
    try {
      const body = req.body || {};
      const event = body.event_type || body.type || body.event || "";
      const checkoutId =
        body.id ||
        body.checkout_id ||
        body.data?.id ||
        body.payload?.id ||
        null;
      const checkoutReference =
        body.checkout_reference ||
        body.data?.checkout_reference ||
        body.payload?.checkout_reference ||
        null;
      const status = String(body.status || body.data?.status || "").toUpperCase();

      let purchase = null;
      if (checkoutReference) {
        purchase = await billing.getPurchase(String(checkoutReference));
      }
      if (!purchase && checkoutId) {
        purchase = await billing.getPurchaseByCheckoutId(String(checkoutId));
      }
      if (!purchase) {
        console.warn("sumup-webhook: purchase not found", { event, checkoutId, checkoutReference });
        return res.json({ ok: true, ignored: true });
      }
      if (status === "PAID" || String(event).toLowerCase().includes("paid")) {
        await billing.markPurchasePaid(purchase.id);
      } else if (checkoutId) {
        try {
          const checkout = await sumupGetCheckout(String(checkoutId));
          if (isSumupPaid(checkout)) {
            await billing.markPurchasePaid(purchase.id);
          }
        } catch (err) {
          console.warn("sumup-webhook poll failed", err.message);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("sumup-webhook error", err.message);
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get("/api/admin/promos", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ items: await billing.listPromos() });
  });

  app.post("/api/admin/promos", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const code = String(req.body?.code || "").trim();
    const analyses = Number(req.body?.analyses);
    const enabled = req.body?.enabled !== false;
    if (!code || !Number.isFinite(analyses) || analyses < 1) {
      return res.status(400).json({ error: "code and analyses (>=1) required" });
    }
    try {
      const promo = await billing.upsertPromo(code, analyses, enabled);
      res.json(promo);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.delete("/api/admin/promos/:code", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const deleted = await billing.deletePromo(req.params.code);
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  app.get("/api/searches", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    pruneCache();
    const limit = Math.min(Number(req.query.limit) || 100, MAX_HISTORY);
    res.json({
      cacheTtlMs: CACHE_TTL_MS,
      store: history.kind,
      items: await history.list(limit),
    });
  });

  app.delete("/api/searches", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await history.clear();
    res.json({ ok: true });
  });

  /**
   * Shared trip duration: cache hit (15 min) or Google Geocode + Routes.
   * Body: { pickup: string, dropoff: string }
   */
  app.post("/api/trip-duration", async (req, res) => {
    const pickup = String(req.body?.pickup || "").trim();
    const dropoff = String(req.body?.dropoff || "").trim();
    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "pickup and dropoff required" });
    }
    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ error: "GOOGLE_MAPS_API_KEY not configured on server" });
    }

    pruneCache();
    const key = routeKey(pickup, dropoff);
    const now = Date.now();
    const cached = routeCache.get(key);
    if (cached && now - cached.cachedAtMs <= CACHE_TTL_MS) {
      const entry = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        atMs: now,
        pickup,
        dropoff,
        durationMinutes: cached.durationMinutes,
        distanceMeters: cached.distanceMeters,
        source: "cache",
        cacheAgeMs: now - cached.cachedAtMs,
      };
      await history.push(entry);
      return res.json({
        durationMinutes: cached.durationMinutes,
        distanceMeters: cached.distanceMeters,
        cached: true,
        source: "cache",
        cacheTtlMs: CACHE_TTL_MS,
        cacheAgeMs: entry.cacheAgeMs,
      });
    }

    const started = Date.now();
    try {
      const [origin, destination] = await Promise.all([geocode(pickup), geocode(dropoff)]);
      const route = await computeRoute(origin, destination);
      routeCache.set(key, {
        durationMinutes: route.durationMinutes,
        distanceMeters: route.distanceMeters,
        cachedAtMs: Date.now(),
        pickup,
        dropoff,
      });
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        atMs: Date.now(),
        pickup,
        dropoff,
        pickupFormatted: origin.formatted,
        dropoffFormatted: destination.formatted,
        durationMinutes: route.durationMinutes,
        distanceMeters: route.distanceMeters,
        source: "google",
        latencyMs: Date.now() - started,
      };
      await history.push(entry);
      return res.json({
        durationMinutes: route.durationMinutes,
        distanceMeters: route.distanceMeters,
        cached: false,
        source: "google",
        cacheTtlMs: CACHE_TTL_MS,
        latencyMs: entry.latencyMs,
      });
    } catch (err) {
      console.error("trip-duration error", err.message);
      await history.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        atMs: Date.now(),
        pickup,
        dropoff,
        source: "error",
        error: String(err.message || err),
        latencyMs: Date.now() - started,
      });
      return res.status(502).json({ error: String(err.message || err) });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CourseOK route backend on http://0.0.0.0:${PORT}`);
    console.log(`Maps key: ${GOOGLE_MAPS_API_KEY ? "configured" : "MISSING"}`);
    console.log(`SumUp: ${SUMUP_API_KEY && SUMUP_MERCHANT_CODE ? "configured" : "MISSING"}`);
    console.log(`Cache TTL: ${CACHE_TTL_MS / 1000}s`);
    console.log(`History: ${history.kind}`);
    console.log(`Billing: ${billing.kind}`);
    if (PUBLIC_BASE_URL) console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
