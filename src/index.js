const fs = require("fs");
const path = require("path");
const stream = require("stream");
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

/** URL publique vue par les lecteurs (Coolify / Traefik : X-Forwarded-*) */
function publicOrigin(req) {
  const fixed = process.env.PUBLIC_BASE_URL;
  if (fixed) return String(fixed).replace(/\/$/, "");
  const xfHost = (req.get("x-forwarded-host") || "").split(",")[0].trim();
  const xfProto = (req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const host = xfHost || req.get("host") || "localhost";
  const protocol = xfProto || req.protocol || "http";
  return `${protocol}://${host}`.replace(/\/$/, "");
}

function serverInfo(req, content) {
  const base = publicOrigin(req);
  let host = "localhost";
  let protocol = "http";
  try {
    const u = new URL(base);
    host = u.host;
    protocol = u.protocol.replace(":", "");
  } catch {
    /* ignore */
  }
  const hostNoPort = host.split(":")[0];
  const portPart = host.includes(":") ? host.split(":")[1] : null;
  const port =
    portPart || (protocol === "https" ? "443" : String(process.env.PORT || 3000));
  return {
    url: hostNoPort,
    port,
    https_port: "443",
    server_protocol: protocol,
    rtmp_port: "0",
    timezone: content.meta?.timezone || "UTC",
    timestamp_now: tsNow(),
    time_now: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}

function encodeSeg(s) {
  return encodeURIComponent(String(s));
}

function buildMovieUrl(req, username, password, streamId, ext) {
  const o = publicOrigin(req);
  return `${o}/movie/${encodeSeg(username)}/${encodeSeg(password)}/${streamId}.${ext}`;
}

function buildSeriesPlayUrl(req, username, password, episodeId, ext) {
  const o = publicOrigin(req);
  return `${o}/series/${encodeSeg(username)}/${encodeSeg(password)}/${episodeId}.${ext}`;
}

function buildLivePlayUrl(req, username, password, streamId, ext) {
  const o = publicOrigin(req);
  return `${o}/live/${encodeSeg(username)}/${encodeSeg(password)}/${streamId}.${ext}`;
}

/** Résout series_episodes[seriesId] même si la clé diffère (1 vs "1") */
function episodesBucketForSeries(content, seriesIdStr) {
  const raw = content.series_episodes || {};
  const sid = String(seriesIdStr ?? "").trim();
  if (raw[sid] && typeof raw[sid] === "object") return raw[sid];
  const num = Number(sid);
  if (!Number.isNaN(num) && raw[String(num)] && typeof raw[String(num)] === "object")
    return raw[String(num)];
  for (const k of Object.keys(raw)) {
    if (String(k) === sid || String(Number(k)) === sid) return raw[k];
  }
  return {};
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

/** Plusieurs lecteurs envoient l’action en casse variable ou series au lieu de series_id */
function normAction(a) {
  return String(a || "").trim().toLowerCase();
}

function playerApi(req, res) {
  const params = mergeParams(req);
  const action = normAction(params.action);
  const username = params.username;
  const password = params.password;
  const category_id = params.category_id;
  const series_id = params.series_id ?? params.series;
  const vod_id = params.vod_id ?? params.vod_stream_id;
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

  if (!params.action || !String(params.action).trim()) {
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
      return res.json(
        rows.map((s) => ({
          ...s,
          direct_source: buildLivePlayUrl(
            req,
            username,
            password,
            s.stream_id,
            "ts"
          ),
        }))
      );
    }
    case "get_vod_categories":
      return res.json(content.vod_categories || []);
    case "get_vod_streams": {
      let rows = content.vod_streams || [];
      if (cat) rows = rows.filter((r) => String(r.category_id) === cat);
      const mapped = rows.map((v) => {
        const poster =
          v.stream_icon || v.movie_image || v.cover_big || "";
        const ext = v.container_extension || "mp4";
        const play = buildMovieUrl(req, username, password, v.stream_id, ext);
        return {
          ...v,
          stream_icon: poster,
          icon: v.icon || poster,
          movie_image: v.movie_image || poster,
          cover_big: v.cover_big || poster,
          added: v.added || String(tsNow()),
          year: v.year || (v.releasedate ? String(v.releasedate).slice(0, 4) : ""),
          stream_url: play,
          direct_source: play,
        };
      });
      return res.json(mapped);
    }
    case "get_vod_info": {
      const vid = String(vod_id || "");
      const vod = (content.vod_streams || []).find(
        (v) => String(v.stream_id) === vid
      );
      if (!vod) return res.json([]);
      const poster =
        vod.movie_image || vod.cover_big || vod.stream_icon || "";
      const ext = vod.container_extension || "mp4";
      const play = buildMovieUrl(req, username, password, vod.stream_id, ext);
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
          container_extension: ext,
          custom_sid: "",
          direct_source: play,
          stream_url: play,
        },
      });
    }
    case "get_series_categories":
      return res.json(content.series_categories || []);
    case "get_series": {
      let rows = content.series || [];
      if (cat) rows = rows.filter((r) => String(r.category_id) === cat);
      const ts = String(tsNow());
      return res.json(
        rows.map((s) => {
          const cover = s.cover || s.stream_icon || s.cover_big || "";
          const coverBig = s.cover_big || s.cover || "";
          return {
            ...s,
            id: s.id ?? s.series_id,
            series_id: s.series_id,
            cover,
            cover_big: coverBig || cover,
            stream_icon: s.stream_icon || cover,
            last_modified: s.last_modified || ts,
          };
        })
      );
    }
    case "get_series_info": {
      const sidRaw = series_id ?? params.series_id ?? params.series;
      const sid = String(sidRaw ?? "").trim();
      const series = (content.series || []).find(
        (s) => String(s.series_id) === sid
      );
      if (!series) {
        return res.json({
          seasons: [],
          info: {},
          episodes: {},
          episodes_list: [],
        });
      }
      const epBySeason = episodesBucketForSeries(content, sid);
      const episodes = {};
      const episodes_list = [];
      const seasonKeys = Object.keys(epBySeason).sort(
        (a, b) => Number(a) - Number(b)
      );
      for (const seasonKey of seasonKeys) {
        const listRaw = epBySeason[seasonKey] || [];
        const mapped = listRaw.map((ep) => {
          const baseInfo = ep.info || {
            plot: "",
            releasedate: "",
            movie_image: "",
          };
          const epImg =
            baseInfo.movie_image ||
            ep.stream_icon ||
            ep.movie_image ||
            series.cover ||
            "";
          const ext = ep.container_extension || "mp4";
          const epNum =
            ep.episode_num != null && ep.episode_num !== ""
              ? Number(ep.episode_num)
              : 1;
          const epIdNum = Number(ep.id);
          const play = buildSeriesPlayUrl(req, username, password, ep.id, ext);
          const sn = Number(seasonKey);
          const row = {
            id: Number.isFinite(epIdNum) ? epIdNum : ep.id,
            episode_num: Number.isFinite(epNum) ? epNum : 1,
            title: ep.title,
            container_extension: ext,
            stream_icon: ep.stream_icon || epImg,
            info: {
              ...baseInfo,
              movie_image: epImg || baseInfo.movie_image,
            },
            season: Number.isFinite(sn) ? sn : 1,
            series_id: Number(series.series_id),
            direct_source: play,
            stream_url: play,
            url: play,
            custom_sid: ep.custom_sid || "",
            added: String(ep.added || tsNow()),
          };
          episodes_list.push(row);
          return row;
        });
        episodes[seasonKey] = mapped;
      }
      const seasonsArr = seasonKeys.map((sk) => {
        const list = epBySeason[sk] || [];
        const cov = series.cover || "";
        const covB = series.cover_big || series.cover || "";
        const nid = Number(sk);
        return {
          id: Number.isFinite(nid) ? nid : 1,
          name: `Season ${sk}`,
          episode_count: list.length,
          air_date: "",
          cover: cov,
          cover_big: covB,
          overview: "",
          vote_average: 0,
        };
      });
      const cov = series.cover || "";
      const covB = series.cover_big || series.cover || "";
      const seasons_episodes = seasonKeys.map((sk) => {
        const nid = Number(sk);
        return {
          season: Number.isFinite(nid) ? nid : 1,
          episodes: episodes[sk] || [],
        };
      });
      return res.json({
        seasons: seasonsArr,
        info: {
          series_id: Number(series.series_id),
          name: series.name,
          cover: cov,
          cover_big: covB,
          stream_icon: series.stream_icon || cov,
          plot: series.plot || "",
          cast: series.cast || "",
          director: series.director || "",
          genre: series.genre || "",
          releaseDate: series.releaseDate || "",
          rating: String(series.rating ?? "0"),
          category_id: series.category_id,
          backdrop_path: series.backdrop_path || [],
          youtube_trailer: series.youtube_trailer || "",
          episode_run_time: series.episode_run_time || "",
          category_ids: series.category_ids || [Number(series.category_id)],
          last_modified: String(series.last_modified || tsNow()),
        },
        episodes,
        episodes_list,
        seasons_episodes,
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

async function proxyIfAuthed(req, res, username, password, id, lookup) {
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
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers, redirect: "follow" });
    const pass = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
    ];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status);
    if (!upstream.body) {
      res.end();
      return;
    }
    const nodeStream = stream.Readable.fromWeb(upstream.body);
    nodeStream.on("error", () => res.destroy());
    res.on("close", () => {
      try {
        nodeStream.destroy();
      } catch {
        /* ignore */
      }
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send(String(err.message));
    else res.destroy();
  }
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
    redirectIfAuthed(
      req,
      res,
      req.params.username,
      req.params.password,
      path.parse(req.params.streamId).name,
      buildLiveLookup(content)
    );
  });

  app.get("/movie/:username/:password/:vodId", (req, res) => {
    const content = loadContent();
    const id = path.parse(req.params.vodId).name;
    void proxyIfAuthed(
      req,
      res,
      req.params.username,
      req.params.password,
      id,
      buildVodLookup(content)
    );
  });

  app.get("/series/:username/:password/:episodeId", (req, res) => {
    const content = loadContent();
    const id = path.parse(req.params.episodeId).name;
    void proxyIfAuthed(
      req,
      res,
      req.params.username,
      req.params.password,
      id,
      buildSeriesEpisodeLookup(content)
    );
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}

const port = Number(process.env.PORT || 3000);
createApp().listen(port, "0.0.0.0", () => {
  console.log(`demo-xtream-backend listening on ${port}, data=${DATA_PATH}`);
});
