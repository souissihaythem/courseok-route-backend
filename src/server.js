/**
 * CourseOK route backend — shared Google Routes/Geocode cache (15 min) + search history UI.
 * Keep GOOGLE_MAPS_API_KEY in .env only (never commit).
 */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "searches.json");
const MAX_HISTORY = 500;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, { durationMinutes: number, distanceMeters: number|null, cachedAtMs: number, pickup: string, dropoff: string }>} */
const routeCache = new Map();
/** @type {Array<object>} */
let searchHistory = loadHistory();

const app = express();
app.use(express.json({ limit: "32kb" }));
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

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(searchHistory.slice(0, MAX_HISTORY), null, 2));
  } catch (err) {
    console.error("persistHistory failed", err.message);
  }
}

function pushHistory(entry) {
  searchHistory.unshift(entry);
  if (searchHistory.length > MAX_HISTORY) searchHistory.length = MAX_HISTORY;
  persistHistory();
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of routeCache.entries()) {
    if (now - entry.cachedAtMs > CACHE_TTL_MS) routeCache.delete(key);
  }
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

app.get("/api/health", (_req, res) => {
  pruneCache();
  res.json({
    ok: true,
    hasMapsKey: Boolean(GOOGLE_MAPS_API_KEY),
    cacheSize: routeCache.size,
    historySize: searchHistory.length,
    cacheTtlMs: CACHE_TTL_MS,
  });
});

app.get("/api/searches", (req, res) => {
  if (ADMIN_TOKEN && req.header("x-admin-token") !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  pruneCache();
  const limit = Math.min(Number(req.query.limit) || 100, MAX_HISTORY);
  res.json({
    cacheTtlMs: CACHE_TTL_MS,
    items: searchHistory.slice(0, limit),
  });
});

app.delete("/api/searches", (req, res) => {
  if (ADMIN_TOKEN && req.header("x-admin-token") !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  searchHistory = [];
  persistHistory();
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
    pushHistory(entry);
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
    pushHistory(entry);
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
    pushHistory({
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
  console.log(`Cache TTL: ${CACHE_TTL_MS / 1000}s`);
});
