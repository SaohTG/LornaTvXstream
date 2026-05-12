const fs = require("fs");
const path = require("path");
const express = require("express");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_PATH =
  process.env.CONTENT_JSON_PATH || path.join(DATA_DIR, "content.json");
function resolveBundledDefault() {
  if (process.env.DEFAULT_CONTENT_PATH) return process.env.DEFAULT_CONTENT_PATH;
  const inImage = path.join(__dirname, "..", "defaults", "content.default.json");
  if (fs.existsSync(inImage)) return inImage;
  return path.join(__dirname, "..", "data", "content.json");
}

function ensureDataFile() {
  if (fs.existsSync(DATA_PATH)) return;
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const bundled = resolveBundledDefault();
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, DATA_PATH);
    return;
  }
  throw new Error(`Fichier manquant: ${DATA_PATH} (aucun modèle: ${bundled})`);
}

function loadContent() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

function authUser(content, username, password) {
  return content.users.find(
    (u) => u.username === username && u.password === password
  );
}

function tsNow() {
  return Math.floor(Date.now() / 1000);
}

function serverInfo(req, content) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
  let host = req.get("host") || "localhost";
  let protocol = req.protocol || "http";
  try {
    const u = new URL(base);
    host = u.host;
    protocol = u.protocol.replace(":", "");
  } catch {
    /* ignore */
  }
  const port = protocol === "https" ? "443" : String(process.env.PORT || 3000);
  return {
    url: host.split(":")[0],
    port: host.includes(":") ? host.split(":")[1] : port,
    https_port: "443",
    server_protocol: protocol,
    rtmp_port: "0",
    timezone: content.meta?.timezone || "UTC",
    timestamp_now: tsNow(),
    time_now: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}

function buildLiveLookup(content) {
  const map = new Map();
  for (const s of content.live_streams || []) {
    map.set(String(s.stream_id), s.direct_source || "");
  }
  return map;
}

function buildVodLookup(content) {
  const map = new Map();
  for (const s of content.vod_streams || []) {
    map.set(String(s.stream_id), s.direct_source || "");
  }
  return map;
}

function buildSeriesEpisodeLookup(content) {
  const map = new Map();
  const eps = content.series_episodes || {};
  for (const sid of Object.keys(eps)) {
    const seasons = eps[sid];
    for (const se of Object.keys(seasons)) {
      for (const ep of seasons[se]) {
        map.set(String(ep.id), ep.direct_source || "");
      }
    }
  }
  return map;
}

function mergeParams(req) {
  const out = { ...req.query };
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const k of Object.keys(req.body)) out[k] = req.body[k];
  }
  return out;
}

function playerApi(req, res) {
  const { username, password, action, category_id, series_id, vod_id } =
    mergeParams(req);
  let content;
  try {
    content = loadContent();
  } catch (e) {
    return res.status(500).json({ error: "content_json", message: String(e.message) });
  }

  const user = authUser(content, username, password);
  if (!user) {
    return res.status(200).json({
      user_info: { auth: 0, message: "Identifiants invalides" },
    });
  }

  if (!action) {
    const exp = String(tsNow() + 365 * 24 * 3600);
    return res.json({
      user_info: {
        username: user.username,
        password: user.password,
        message: user.message || "OK",
        auth: 1,
        status: "Active",
        exp_date: exp,
        is_trial: "0",
        active_cons: "0",
        created_at: String(tsNow()),
        max_connections: String(user.max_connections ?? 1),
        allowed_output_formats: ["m3u8", "ts", "mp4"],
      },
      server_info: serverInfo(req, content),
    });
  }

  const cat = category_id && category_id !== "all" ? String(category_id) : null;

  switch (action) {
    case "get_live_categories":
      return res.json(content.live_categories || []);
    case "get_live_streams": {
      let rows = content.live_streams || [];
      if (cat) rows = rows.filter((r) => String(r.category_id) === cat);
      return res.json(rows);
    }
    case "get_vod_categories":
      return res.json(content.vod_categories || []);
    case "get_vod_streams": {
      let rows = content.vod_streams || [];
      if (cat) rows = rows.filter((r) => String(r.category_id) === cat);
      return res.json(rows);
    }
    case "get_vod_info": {
      const vid = String(vod_id || "");
      const vod = (content.vod_streams || []).find(
        (v) => String(v.stream_id) === vid
      );
      if (!vod) return res.json([]);
      const poster =
        vod.movie_image || vod.cover_big || vod.stream_icon || "";
      return res.json({
        info: {
          name: vod.name || "",
          o_name: vod.name || "",
          cover_big: poster,
          movie_image: poster,
          releasedate: vod.releasedate || "",
          episode_run_time: vod.episode_run_time || "",
          youtube_trailer: vod.youtube_trailer || "",
          director: vod.director || "",
          actors: vod.cast || "",
          cast: vod.cast || "",
          description: vod.plot || "",
          plot: vod.plot || "",
          country: vod.country || "",
          genre: vod.genre || "",
          backdrop_path: Array.isArray(vod.backdrop_path)
            ? vod.backdrop_path
            : [],
          duration_secs: Number(vod.duration_secs) || 0,
          duration: vod.duration || "",
          video: [],
          audio: [],
          bitrate: 0,
          rating: String(vod.rating ?? ""),
        },
        movie_data: {
          stream_id: vod.stream_id,
          name: vod.name,
          added: String(tsNow()),
          category_id: vod.category_id,
          container_extension: vod.container_extension || "mp4",
          custom_sid: "",
          direct_source: vod.direct_source || "",
        },
      });
    }
    case "get_series_categories":
      return res.json(content.series_categories || []);
    case "get_series": {
      let rows = content.series || [];
      if (cat) rows = rows.filter((r) => String(r.category_id) === cat);
      return res.json(rows);
    }
    case "get_series_info": {
      const sid = String(series_id || "");
      const series = (content.series || []).find((s) => String(s.series_id) === sid);
      if (!series) return res.json([]);
      const seasons = content.series_episodes?.[sid] || {};
      const episodes = {};
      for (const seasonKey of Object.keys(seasons)) {
        episodes[seasonKey] = (seasons[seasonKey] || []).map((ep) => {
          const baseInfo = ep.info || {
            plot: "",
            releasedate: "",
            movie_image: "",
          };
          const epImg =
            baseInfo.movie_image ||
            ep.stream_icon ||
            ep.movie_image ||
            "";
          return {
            id: ep.id,
            episode_num: ep.episode_num,
            title: ep.title,
            container_extension: ep.container_extension || "mp4",
            stream_icon: ep.stream_icon || epImg,
            info: {
              ...baseInfo,
              movie_image: epImg || baseInfo.movie_image,
            },
            season: String(ep.season ?? seasonKey),
            direct_source: ep.direct_source || "",
            custom_sid: "",
            added: String(tsNow()),
          };
        });
      }
      return res.json({
        info: {
          name: series.name,
          cover: series.cover || "",
          cover_big: series.cover_big || series.cover || "",
          plot: series.plot || "",
          cast: series.cast || "",
          director: series.director || "",
          genre: series.genre || "",
          releaseDate: series.releaseDate || "",
          rating: series.rating || "0",
          category_id: series.category_id,
          backdrop_path: series.backdrop_path || [],
          youtube_trailer: series.youtube_trailer || "",
          episode_run_time: series.episode_run_time || "",
          category_ids: series.category_ids || [Number(series.category_id)],
        },
        episodes,
      });
    }
    default:
      return res.status(400).json({ error: "unknown_action", action });
  }
}

function redirectIfAuthed(req, res, username, password, id, lookup) {
  let content;
  try {
    content = loadContent();
  } catch (e) {
    return res.status(500).send("Config error");
  }
  if (!authUser(content, username, password)) {
    return res.status(403).send("Forbidden");
  }
  const url = lookup.get(String(id));
  if (!url) return res.status(404).send("Not found");
  return res.redirect(302, url);
}

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/player_api.php", playerApi);
  app.post("/player_api.php", playerApi);

  app.get("/live/:username/:password/:streamId", (req, res) => {
    const content = loadContent();
    redirectIfAuthed(req, res, req.params.username, req.params.password, req.params.streamId, buildLiveLookup(content));
  });

  app.get("/movie/:username/:password/:vodId", (req, res) => {
    const content = loadContent();
    const id = path.parse(req.params.vodId).name;
    redirectIfAuthed(req, res, req.params.username, req.params.password, id, buildVodLookup(content));
  });

  app.get("/series/:username/:password/:episodeId", (req, res) => {
    const content = loadContent();
    const id = path.parse(req.params.episodeId).name;
    redirectIfAuthed(req, res, req.params.username, req.params.password, id, buildSeriesEpisodeLookup(content));
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}

const port = Number(process.env.PORT || 3000);
createApp().listen(port, "0.0.0.0", () => {
  console.log(`demo-xtream-backend listening on ${port}, data=${DATA_PATH}`);
});
