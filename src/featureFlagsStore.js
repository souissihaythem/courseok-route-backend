/**
 * Remote feature flags (admin-gated). Durable via Gist when configured, else local JSON.
 */
const fs = require("fs");
const path = require("path");
const { loadGistJson, saveGistJson } = require("./gistStore");

const FLAGS_FILE = "courseok-feature-flags.json";
const DEFAULTS = {
  /** When true, app may show Uber/Bolt auto-refuse toggles and perform refuse taps. */
  rejectBadTrip: false,
  /** Front-camera dashcam tab + FAB (informational / future kill-switch). */
  dashcam: true,
  /** Near-home destination alert on scored banner. */
  nearHomeAlert: true,
};

function createFeatureFlagsStore(dataDir) {
  const localPath = path.join(dataDir, "feature-flags.json");
  const token = (process.env.GITHUB_TOKEN || "").trim();
  const gistId = (process.env.FEATURE_FLAGS_GIST_ID || process.env.ANALYTICS_GIST_ID || "").trim();
  const useGist = Boolean(token && gistId);

  /** @type {typeof DEFAULTS} */
  let state = { ...DEFAULTS };
  let kind = "memory";

  function normalize(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      rejectBadTrip: Boolean(src.rejectBadTrip),
      dashcam: src.dashcam === undefined ? DEFAULTS.dashcam : Boolean(src.dashcam),
      nearHomeAlert:
        src.nearHomeAlert === undefined ? DEFAULTS.nearHomeAlert : Boolean(src.nearHomeAlert),
    };
  }

  async function load() {
    if (useGist) {
      try {
        const data = await loadGistJson(gistId, FLAGS_FILE, token);
        if (data) {
          state = normalize({ ...DEFAULTS, ...data });
          kind = "gist";
          return;
        }
      } catch (err) {
        console.warn("feature flags gist load failed:", err.message || err);
      }
    }
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(localPath)) {
        state = normalize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(localPath, "utf8")) });
        kind = useGist ? "gist+local" : "local";
        return;
      }
    } catch (err) {
      console.warn("feature flags local load failed:", err.message || err);
    }
    state = { ...DEFAULTS };
    kind = useGist ? "gist" : "local";
  }

  async function persist() {
    if (useGist) {
      await saveGistJson(gistId, FLAGS_FILE, token, state);
      kind = "gist";
      return;
    }
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(state, null, 2));
    kind = "local";
  }

  return {
    get kind() {
      return kind;
    },
    async get() {
      return { ...state };
    },
    async set(partial) {
      state = normalize({ ...state, ...partial });
      await persist();
      return { ...state };
    },
    async init() {
      await load();
      return this;
    },
  };
}

module.exports = { createFeatureFlagsStore, DEFAULT_FEATURE_FLAGS: DEFAULTS };
