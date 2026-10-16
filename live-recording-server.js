/**
 * Live Screen Recording Server (mediasoup + FFmpeg) - FIXED
 *
 * Signaling is unchanged:
 *   request-start-stream, request-stop-stream, request-start-recording,
 *   request-stop-recording, joinRoom, createConsumerTransport,
 *   connectConsumerTransport, consume, ffmpeg-started, ffmpeg-error,
 *   start-ffmpeg / stop-ffmpeg (server -> agent).
 *
 * What was broken (and is fixed here):
 *   1. buildRecordingVideoArgs() in "encode" mode called itself forever and
 *      referenced an undefined `sdpPath` -> stack overflow / ReferenceError.
 *   2. waitForProducer() checked `transport.tuple.localPort`, which is ALWAYS set,
 *      so it never actually waited for agent RTP. Now it waits for the
 *      comedia remote tuple (real RTP arrival) before creating the producer.
 *   3. FFmpeg probe settings (analyzeduration 120s / probesize 200MB) made the
 *      recorder sit silent past the 60s startup timeout. Now 10s / 10MB.
 *   4. Recorder PlainTransports listen on 127.0.0.1 and consume with codecs
 *      only (no header extensions) for a clean SDP/RTP match.
 *   5. Stop now sends "q" to FFmpeg stdin (works on Linux AND Windows) so the
 *      TS file is finalised properly; SIGINT/SIGKILL only as fallback.
 *   6. TS -> MP4 uses full stream copy (no re-encode), longer timeout.
 *   7. Failed start (no RTP) now cleans up transports and tells the agent to stop.
 *   8. Viewers no longer get duplicate consumers for the same producer.
 *
 * Environment:
 *   PORT=3000
 *   ANNOUNCED_IP=<public-ip>
 *   FFMPEG_PATH=ffmpeg
 *   RECORDINGS_DIR=./recordings
 *   AUTO_RECORD=true
 *   VIEWER_BITRATE=8000000
 *   VIEWER_MAX_INCOMING_BITRATE=12000000
 *   RECORDING_VIDEO_MODE=copy        # copy | encode
 *   RECORDING_AUDIO_ENABLED=true     # false = record video only
 *   RECORDING_VIDEO_BITRATE=6000k    # encode mode only
 *   RECORDING_VIDEO_CRF=18           # encode mode only
 *   RECORDING_VIDEO_PRESET=veryfast  # encode mode only
 *   RECORDING_MAX_WIDTH=0            # encode mode only, 0 = keep source
 *   RECORDING_MAX_HEIGHT=0           # encode mode only, 0 = keep source
 *   RECORDING_STARTUP_TIMEOUT_MS=60000
 *   RECORDING_DELETE_DAYS=0          # 0 = keep forever; N = delete date folders and their cloud copies N or more days old
 *   RECORDING_MAINTENANCE_INTERVAL_MINUTES=10
 *   PRODUCER_RTP_WAIT_MS=20000
 *   MEDIASOUP_MIN_PORT=40000
 *   MEDIASOUP_MAX_PORT=50000
 *
 * package.json must contain: { "type": "module" }
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env file from project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

import express from "express";
import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { Server } from "socket.io";
import mediasoup from "mediasoup";
import * as storage from "./storage.js";

const app = express();
const httpServer = http.createServer(app);

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const int = (v, d) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : d;
};

const PORT = int(process.env.PORT, 4000);
const PUBLIC_ANNOUNCED_IP = process.env.ANNOUNCED_IP || "20.219.2.109";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || "./recordings");
const RECORDING_FOLDER = "recording";
const RECORDING_FILE_RE = /^Video_\d{14}\.(mp4|ts)$/i;
const RECORDING_MP4_RE = /^Video_\d{14}\.mp4$/i;
const AUTO_RECORD = (process.env.AUTO_RECORD || "true").toLowerCase() !== "false";

const VIEWER_BITRATE = int(process.env.VIEWER_BITRATE, 8_000_000);
const VIEWER_MAX_INCOMING_BITRATE = int(process.env.VIEWER_MAX_INCOMING_BITRATE, 12_000_000);

const RECORDING_VIDEO_MODE = (process.env.RECORDING_VIDEO_MODE || "copy").toLowerCase();
const RECORDING_AUDIO_ENABLED = (process.env.RECORDING_AUDIO_ENABLED || "true").toLowerCase() !== "false";
const RECORDING_VIDEO_BITRATE = process.env.RECORDING_VIDEO_BITRATE || "6000k";
const RECORDING_VIDEO_CRF = process.env.RECORDING_VIDEO_CRF || "18";
const RECORDING_VIDEO_PRESET = process.env.RECORDING_VIDEO_PRESET || "veryfast";
const RECORDING_MAX_WIDTH = int(process.env.RECORDING_MAX_WIDTH, 0);
const RECORDING_MAX_HEIGHT = int(process.env.RECORDING_MAX_HEIGHT, 0);
const RECORDING_PLAYBACK_COPY = (process.env.RECORDING_PLAYBACK_COPY || "true").toLowerCase() !== "false";
const PLAYBACK_SUFFIX = ".play.mp4";
const isPlaybackCopy = (name) => name.toLowerCase().endsWith(PLAYBACK_SUFFIX);
const playbackPathFor = (mp4Path) => mp4Path.replace(/\.mp4$/i, PLAYBACK_SUFFIX);
const PLAYBACK_VARIANTS = [
    { key: "low", width: 854, height: 480, crf: "28", bitrate: "800k", bufferSize: "1600k" },
    { key: "medium", width: 1280, height: 720, crf: "25", bitrate: "1500k", bufferSize: "3000k" },
    { key: "high", width: 1920, height: 1080, crf: "22", bitrate: "3000k", bufferSize: "6000k" },
];

// Per-request quality from the agent. high = stream copy, so no transcoding CPU.
const RECORDING_QUALITY_PROFILES = {
    high: { mode: "copy" },
    medium: { mode: "encode", crf: "23", bitrate: "3000k", maxWidth: 1280, maxHeight: 720 },
    low: { mode: "encode", crf: "28", bitrate: "1500k", maxWidth: 640, maxHeight: 480 },
};

const RECORDING_STARTUP_TIMEOUT_MS = int(process.env.RECORDING_STARTUP_TIMEOUT_MS, 60_000);
const PRODUCER_RTP_WAIT_MS = int(process.env.PRODUCER_RTP_WAIT_MS, 20_000);

// Storage configuration
const LOGIN_API_URL = process.env.LOGIN_API_URL || "";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";
const STORAGE_CONFIG_URL = process.env.STORAGE_CONFIG_URL || "";

// Recording status APIs
const ADD_RECORDING_API_URL = process.env.ADD_RECORDING_API_URL || "";
const UPDATE_RECORDING_API_URL = process.env.UPDATE_RECORDING_API_URL || "";

const NUM_WORKERS = Math.max(
    1,
    int(process.env.MEDIASOUP_WORKERS, Math.max(1, os.cpus().length - 1))
);

const allowedOrigins = [
    "https://aedownload.mera.work",
    "https://dev.mera.work",
    "https://localhost:3000",
    "http://localhost:3000",
    // Add other trusted frontend origins here
];

const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH", "HEAD"],
        credentials: true,
    },
    pingInterval: 25_000,
    pingTimeout: 60_000,
});

app.get("/", (_req, res) => res.send("Mediasoup live recording server is alive"));

/* Serves the bundled hls.js so players can avoid the public CDN. Callers fall
   back to the CDN when the dependency is not installed. */
app.get("/hls.min.js", (_req, res) => {
    const hlsPath = path.join(__dirname, "node_modules", "hls.js", "dist", "hls.min.js");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.sendFile(hlsPath, (err) => {
        if (!err || res.headersSent) return;
        warn(`hls.min.js unavailable: ${err.message}`);
        res.status(404).json({ error: "hls.js is not installed on this server" });
    });
});

app.get("/status", (_req, res) =>
    res.json({
        status: "ok",
        uptime: process.uptime(),
        recordingsDirectory: RECORDINGS_DIR,
        autoRecord: AUTO_RECORD,
        viewerBitrate: VIEWER_BITRATE,
        viewerMaxIncomingBitrate: VIEWER_MAX_INCOMING_BITRATE,
        recordingVideoMode: RECORDING_VIDEO_MODE,
        recordingAudioEnabled: RECORDING_AUDIO_ENABLED,
        recordingVideoBitrate: RECORDING_VIDEO_BITRATE,
        recordingVideoCrf: RECORDING_VIDEO_CRF,
        recordingVideoPreset: RECORDING_VIDEO_PRESET,
        recordingMaxWidth: RECORDING_MAX_WIDTH,
        recordingMaxHeight: RECORDING_MAX_HEIGHT,
    })
);

/* ------------------------------------------------------------------ */
/* Recording lookup API (org / user / date)                            */
/* ------------------------------------------------------------------ */

const RECORDINGS_API_KEY = process.env.RECORDINGS_API_KEY || "";
const isValidDate = (v) => typeof v === "string" && parseFolderDate(v) !== null;

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isValidApiKey(req) {
    return safeEqual(req.get("x-api-key") || "", RECORDINGS_API_KEY);
}

function signRecordingUrl(orgId, email, date, name) {
    return crypto
        .createHmac("sha256", RECORDINGS_API_KEY)
        .update(`${orgId}|${email}|${date}|${name}`)
        .digest("hex");
}

function hasValidSignature(query) {
    const sig = signRecordingUrl(String(query.orgId), String(query.email), String(query.date), String(query.name));
    return safeEqual(query.sig ?? "", sig);
}

function recordingFileUrl(orgId, email, date, name, play = false) {
    const query = new URLSearchParams({ orgId, email, date, name, sig: signRecordingUrl(orgId, email, date, name) });
    if (play) query.set("play", "1");
    return `/api/recordings/file?${query}`;
}

function recordingPlaylistUrl(orgId, email, date, name, variant = "auto") {
    const query = new URLSearchParams({
        orgId,
        email,
        date,
        name,
        sig: signRecordingUrl(String(orgId), String(email), String(date), String(name)),
        variant,
    });
    return `/api/recordings/playlist?${query}`;
}

function requireRecordingsApiKey(req, res, next) {
    if (!RECORDINGS_API_KEY) {
        return res.status(503).json({ error: "RECORDINGS_API_KEY is not configured on the server" });
    }
    if (!isValidApiKey(req)) return res.status(401).json({ error: "Invalid API key" });
    next();
}

/* File URLs are accepted with either the API key header or a signed, unexpired link. */
function requireRecordingAccess(req, res, next) {
    if (!RECORDINGS_API_KEY) {
        return res.status(503).json({ error: "RECORDINGS_API_KEY is not configured on the server" });
    }
    if (isValidApiKey(req) || hasValidSignature(req.query)) return next();
    res.status(401).json({ error: "Missing API key or valid signed URL" });
}

// app.use("/api/recordings", (req, res, next) => {
//   const origin = req.get("origin");
//   if (origin && ALLOWED_ORIGINS.includes(origin)) {
//     res.set("Access-Control-Allow-Origin", origin);
//     res.set("Access-Control-Allow-Headers", "x-api-key");
//     res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
//     res.set("Vary", "Origin");
//   }
//   if (req.method === "OPTIONS") return res.sendStatus(204);
//   next();
// });




app.use("/api/recordings", (req, res, next) => {
    const origin = req.headers.origin;
    res.vary("Origin");

    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader(
            "Access-Control-Allow-Headers",
            "x-api-key, Range, Content-Type"
        );
        res.setHeader(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges"
        );
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

async function listRecordingFiles(orgId, email, date) {
    const dir = recordingFolder(orgId, email, date);
    let names;
    try {
        names = await fs.readdir(dir);
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }

    const files = [];
    for (const name of names.filter((n) => RECORDING_MP4_RE.test(n)).sort()) {
        const stat = await fs.stat(path.join(dir, name));
        files.push({ name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    return files;
}

async function listOrgRecordingsForDate(orgId, date) {
    const orgDir = path.join(RECORDINGS_DIR, safeName(orgId));
    const userEntries = await fs.readdir(orgDir, { withFileTypes: true }).catch((err) => {
        if (err.code === "ENOENT") return [];
        throw err;
    });

    const users = [];
    for (const entry of userEntries.filter((e) => e.isDirectory())) {
        const email = decodeURIComponent(entry.name);
        const files = await listRecordingFiles(orgId, email, date);
        if (files.length) users.push({ email, files });
    }
    return users;
}

app.get("/api/recordings", requireRecordingsApiKey, async (req, res) => {
    const orgId = req.query.orgId;
    const email = req.query.email;
    const date = req.query.date ?? getTodayDate();
    if (!orgId || !email) return res.status(400).json({ error: "orgId and email are required" });
    if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

    try {
        const files = await listRecordingFiles(String(orgId), String(email), date);
        const recordings = files.map((f) => ({
            ...f,
            url: recordingFileUrl(String(orgId), String(email), date, f.name),
            playUrl: recordingFileUrl(String(orgId), String(email), date, f.name, true),
            hlsUrl: recordingPlaylistUrl(String(orgId), String(email), date, f.name),
        }));
        res.json({ orgId, email, date, count: recordings.length, recordings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/recordings/getOrganizationRecordingsByDate", requireRecordingsApiKey, async (req, res) => {
    const orgId = req.query.orgId;
    const date = req.query.date ?? getTodayDate();
    if (!orgId) return res.status(400).json({ error: "orgId is required" });
    if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

    try {
        const users = await listOrgRecordingsForDate(String(orgId), date);
        const result = users.map(({ email, files }) => ({
            email,
            count: files.length,
            recordings: files.map((f) => ({
                ...f,
                url: recordingFileUrl(String(orgId), email, date, f.name),
                playUrl: recordingFileUrl(String(orgId), email, date, f.name, true),
                hlsUrl: recordingPlaylistUrl(String(orgId), email, date, f.name),
            })),
        }));
        const count = result.reduce((total, user) => total + user.count, 0);
        res.json({ orgId, date, userCount: result.length, count, users: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/recordings/playlist", requireRecordingAccess, async (req, res) => {
    const orgId = req.query.orgId;
    const email = req.query.email;
    const date = req.query.date;
    const name = req.query.name;
    const variant = req.query.variant ?? "auto";

    if (!orgId || !email || !isValidDate(date) || typeof name !== "string") {
        return res.status(400).json({ error: "orgId, email, date (YYYY-MM-DD) and name are required" });
    }

    const fileName = path.basename(name);
    if (fileName !== name || !RECORDING_FILE_RE.test(fileName) || !RECORDING_MP4_RE.test(fileName)) {
        return res.status(400).json({ error: "invalid recording name" });
    }

    const filePath = path.join(recordingFolder(String(orgId), String(email), date), fileName);
    try {
        await fs.access(filePath);
        if (req.query.segment) {
            return streamHlsSegment(req, res, filePath, variant, req.query.segment);
        }
        return streamHlsPlaylist(req, res, filePath, variant);
    } catch (err) {
        if (err?.code === "ENOENT") return res.status(404).json({ error: "recording not found" });
        return res.status(500).json({ error: "Unable to load playlist" });
    }
});

app.get("/api/recordings/hls", requireRecordingAccess, async (req, res) => {
    const orgId = req.query.orgId;
    const email = req.query.email;
    const date = req.query.date;
    const name = req.query.name;
    const variant = req.query.variant ?? "auto";
    const segment = req.query.segment;

    if (!orgId || !email || !isValidDate(date) || typeof name !== "string") {
        return res.status(400).json({ error: "orgId, email, date (YYYY-MM-DD) and name are required" });
    }

    const fileName = path.basename(name);
    if (fileName !== name || !RECORDING_FILE_RE.test(fileName) || !RECORDING_MP4_RE.test(fileName)) {
        return res.status(400).json({ error: "invalid recording name" });
    }

    const filePath = path.join(recordingFolder(String(orgId), String(email), date), fileName);
    try {
        await fs.access(filePath);
        if (segment) return streamHlsSegment(req, res, filePath, variant, segment);
        return streamHlsPlaylist(req, res, filePath, variant);
    } catch (err) {
        if (err?.code === "ENOENT") return res.status(404).json({ error: "recording not found" });
        return res.status(500).json({ error: "Unable to load adaptive playlist" });
    }
});

app.get("/api/recordings/file", requireRecordingAccess, async (req, res) => {
    const orgId = req.query.orgId;
    const email = req.query.email;
    const date = req.query.date;
    const name = req.query.name;
    if (!orgId || !email || !isValidDate(date) || typeof name !== "string") {
        return res.status(400).json({ error: "orgId, email, date (YYYY-MM-DD) and name are required" });
    }
    const fileName = path.basename(name);
    if (fileName !== name || !RECORDING_FILE_RE.test(fileName)) {
        return res.status(400).json({ error: "invalid file name" });
    }

    let filePath = path.join(recordingFolder(String(orgId), String(email), date), fileName);
    if (req.query.play === "1" && RECORDING_MP4_RE.test(fileName)) {
        const playPath = playbackPathFor(filePath);
        if (await fs.access(playPath).then(() => true, () => false)) filePath = playPath;
    }
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return res.status(404).json({ error: "recording not found" });
        const fileSize = stat.size;
        const range = req.headers.range;

        res.set({
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
            "Content-Type": "video/mp4",
        });

        if (!range) {
            res.set("Content-Length", fileSize);
            return res.sendFile(filePath, (err) => {
                if (err && !res.headersSent) res.status(err.status || 500).json({ error: err.message });
            });
        }

        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
            res.set("Content-Range", `bytes */${fileSize}`);
            return res.status(416).end();
        }

        let start;
        let end;
        if (match[1]) {
            start = Number.parseInt(match[1], 10);
            end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
        } else {
            const suffixLength = Number.parseInt(match[2], 10);
            start = Math.max(fileSize - suffixLength, 0);
            end = fileSize - 1;
        }

        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= fileSize ||
            end < start
        ) {
            res.set("Content-Range", `bytes */${fileSize}`);
            return res.status(416).end();
        }

        end = Math.min(end, fileSize - 1);
        res.status(206);
        res.set({
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        });
        return createReadStream(filePath, { start, end }).pipe(res);
    } catch (err) {
        if (err?.code === "ENOENT") return res.status(404).json({ error: "recording not found" });
        return res.status(500).json({ error: "Unable to read recording" });
    }
});

/* ------------------------------------------------------------------ */
/* Codecs                                                              */
/* ------------------------------------------------------------------ */

const mediaCodecs = [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48_000, channels: 2 },
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90_000,
        parameters: { "packetization-mode": 1, "profile-level-id": "42e01f" },
        rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "ccm", parameter: "fir" },
            { type: "transport-cc" },
        ],
    },
];

/* ------------------------------------------------------------------ */
/* State + helpers                                                     */
/* ------------------------------------------------------------------ */

const workers = [];
let workerIndex = 0;

const agents = new Map(); // orgId -> Map(agentId -> socketId)
const admins = new Map(); // orgId -> Set(socketId)
const onlineUsers = new Map(); // orgId -> Map(userId -> Set(socketId))
const rooms = new Map(); // orgId -> Map(roomName -> room)
const allocatedRecordingPorts = new Set();

const stamp = () => new Date().toISOString();
const log = (...a) => console.log(stamp(), ...a);
const warn = (...a) => console.warn(stamp(), ...a);
const error = (...a) => console.error(stamp(), ...a);
const debug = (process.env.DEBUG_STORAGE === "true" ? (...a) => console.debug(stamp(), ...a) : () => { });

function ensureMap(parent, key) {
    if (!parent.has(key)) parent.set(key, new Map());
    return parent.get(key);
}
function ensureSet(parent, key) {
    if (!parent.has(key)) parent.set(key, new Set());
    return parent.get(key);
}
function reply(cb, value) {
    if (typeof cb === "function") cb(value);
}
function makeStreamKey(agentId, targetUserId, roomName) {
    return `${agentId}:${targetUserId}:${roomName}`;
}
function safeName(value) {
    return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100) || "unknown";
}

/**
 * Get current date in YYYY-MM-DD format
 */
function getTodayDate() {
    return formatFolderDate(new Date());
}

// recordings/{orgId}/{encoded userEmail}/{YYYY-MM-DD}/recording/
function recordingFolder(orgId, userEmail, folderDate) {
    const emailFolder = encodeURIComponent(String(userEmail || "unknown"));
    return path.join(RECORDINGS_DIR, safeName(orgId), emailFolder, folderDate, RECORDING_FOLDER);
}

function getRecordingDir(orgId, userEmail, when = new Date()) {
    return recordingFolder(orgId, userEmail, formatFolderDate(when));
}

// Video_{YYYYMMDDHHmmss}.{ext}
function recordingFileName(when, ext) {
    return `Video_${formatFileStamp(when)}.${ext}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Mediasoup workers / rooms                                           */
/* ------------------------------------------------------------------ */

async function createWorker() {
    const worker = await mediasoup.createWorker({
        rtcMinPort: int(process.env.MEDIASOUP_MIN_PORT, 40000),
        rtcMaxPort: int(process.env.MEDIASOUP_MAX_PORT, 50000),
        logLevel: process.env.MEDIASOUP_LOG_LEVEL || "warn",
    });

    worker._rooms = new Set();
    worker.on("died", () => {
        error(`Mediasoup worker ${worker.pid} died; exiting so the process manager restarts the server.`);
        process.exit(1);
    });

    workers.push(worker);
    return worker;
}

async function getWorker() {
    if (!workers.length) {
        for (let i = 0; i < NUM_WORKERS; i++) await createWorker();
        log(`Created ${workers.length} mediasoup worker(s)`);
    }
    const worker = workers[workerIndex];
    workerIndex = (workerIndex + 1) % workers.length;
    return worker;
}

async function createRoom(orgId, roomName) {
    const orgRooms = ensureMap(rooms, orgId);
    if (orgRooms.has(roomName)) return orgRooms.get(roomName);

    const worker = await getWorker();
    const router = await worker.createRouter({ mediaCodecs });

    const room = {
        router,
        worker,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        activeStreams: new Map(),
        recordings: new Map(),
    };

    worker._rooms.add(`${orgId}:${roomName}`);
    orgRooms.set(roomName, room);
    log(`Room created org=${orgId} room=${roomName}`);
    return room;
}

function emitRoom(orgId, roomName, event, payload) {
    io.to(`org:${orgId}:room:${roomName}`).emit(event, payload);
}

function notifyAgent(orgId, agentId, event, payload) {
    const socketId = agents.get(orgId)?.get(agentId);
    if (socketId) io.to(socketId).emit(event, payload);
    return Boolean(socketId);
}

function resolvePortFromTransport(transport) {
    return transport?.tuple?.localPort || null;
}

/* ------------------------------------------------------------------ */
/* Initialize storage module                                           */
/* ------------------------------------------------------------------ */

storage.initStorage({
    log,
    warn,
    error,
    debug,
    emitRoom,
    loginApiUrl: LOGIN_API_URL,
    superAdminEmail: SUPER_ADMIN_EMAIL,
});

log(`[Storage] Initialized with:`);
if (SUPER_ADMIN_EMAIL) log(`[Storage]   Super Admin: ${SUPER_ADMIN_EMAIL}`);
if (LOGIN_API_URL) log(`[Storage]   Login API: ${LOGIN_API_URL}`);
if (STORAGE_CONFIG_URL) log(`[Storage]   Config API: ${STORAGE_CONFIG_URL}`);


/**
 * Wait until the agent's RTP actually arrives (comedia learns the remote
 * tuple), then create the producer. Resolves null on timeout.
 */
function waitForProducer({ room, transport, rtpOptions, kind }) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;

        const finish = (producer) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            transport.removeListener("tuple", onTuple);
            resolve(producer || null);
        };

        const create = async () => {
            try {
                const producer = await transport.produce(rtpOptions);
                room.producers.set(producer.id, producer);
                producer.on("transportclose", () => room.producers.delete(producer.id));
                producer.on("close", () => room.producers.delete(producer.id));
                log(`${kind} producer created: ${producer.id}`);

                const statsTimer = setInterval(async () => {
                    try {
                        for (const r of await producer.getStats()) {
                            log(`${kind} in: packets=${r.packetCount} lost=${r.packetsLost} jitter=${r.jitter}`);
                        }
                    } catch { }
                }, 5000);
                producer.on("close", () => clearInterval(statsTimer));
                producer.on("transportclose", () => clearInterval(statsTimer));
                finish(producer);
            } catch (err) {
                error(`Unable to create ${kind} producer:`, err?.message || err);
                finish(null);
            }
        };

        const onTuple = () => void create();

        timer = setTimeout(() => {
            warn(`No ${kind} RTP arrived on transport ${transport.id} within ${PRODUCER_RTP_WAIT_MS}ms`);
            try {
                transport.close();
            } catch { }
            room.transports.delete(transport.id);
            finish(null);
        }, PRODUCER_RTP_WAIT_MS);

        // remoteIp is only set once the first RTP packet has been received.
        if (transport.tuple?.remoteIp) {
            void create();
        } else {
            transport.once("tuple", onTuple);
        }
    });
}

/* ------------------------------------------------------------------ */
/* Recording helpers                                                   */
/* ------------------------------------------------------------------ */

/** Allocate two consecutive free UDP ports (RTP = port, RTCP = port + 1). */
function allocateUdpPortPair(attempt = 0) {
    return new Promise((resolve, reject) => {
        if (attempt > 20) return reject(new Error("Unable to allocate UDP port pair"));

        const a = dgram.createSocket("udp4");
        a.once("error", (err) => {
            try { a.close(); } catch { }
            reject(err);
        });

        a.bind(0, "127.0.0.1", () => {
            const port = a.address().port;
            const b = dgram.createSocket("udp4");

            const retry = () => {
                try { a.close(); } catch { }
                try { b.close(); } catch { }
                allocateUdpPortPair(attempt + 1).then(resolve, reject);
            };

            b.once("error", retry);
            b.bind(port + 1, "127.0.0.1", () => {
                a.close(() =>
                    b.close(() => {
                        if (allocatedRecordingPorts.has(port) || allocatedRecordingPorts.has(port + 1)) {
                            return allocateUdpPortPair(attempt + 1).then(resolve, reject);
                        }
                        allocatedRecordingPorts.add(port);
                        allocatedRecordingPorts.add(port + 1);
                        resolve(port);
                    })
                );
            });
        });
    });
}

function releaseRecordingPort(port) {
    if (port) {
        allocatedRecordingPorts.delete(port);
        allocatedRecordingPorts.delete(port + 1);
    }
}

function codecToSdp(kind, port, codec, spropParameterSets) {
    const pt = codec.payloadType;
    const subtype = codec.mimeType.split("/")[1];
    let sdp = `m=${kind} ${port} RTP/AVP ${pt}\r\n`;
    sdp += `a=rtpmap:${pt} ${subtype}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ""}\r\n`;

    const parameters = { ...(codec.parameters || {}) };
    if (subtype.toLowerCase() === "h264") {
        if (!parameters["profile-level-id"]) parameters["profile-level-id"] = "42e01f";
        if (!parameters["packetization-mode"]) parameters["packetization-mode"] = "1";
        if (spropParameterSets && !parameters["sprop-parameter-sets"]) {
            parameters["sprop-parameter-sets"] = spropParameterSets;
        }
    }

    if (Object.keys(parameters).length) {
        const fmtp = Object.entries(parameters)
            .map(([k, v]) => `${k}=${v}`)
            .join(";");
        sdp += `a=fmtp:${pt} ${fmtp}\r\n`;
    }

    sdp += "a=recvonly\r\n";
    return sdp;
}

function makeSdp(entries) {
    const host = "127.0.0.1"; // FFmpeg runs on the same machine as mediasoup
    let sdp = "v=0\r\n";
    sdp += `o=- 0 0 IN IP4 ${host}\r\n`;
    sdp += "s=mediasoup-live-recording\r\n";
    sdp += `c=IN IP4 ${host}\r\n`;
    sdp += "t=0 0\r\n";
    for (const e of entries) sdp += codecToSdp(e.kind, e.port, e.codec, e.spropParameterSets);
    return sdp;
}

async function disposeRecordingResources(recording) {
    for (const c of recording.consumers || []) {
        try {
            c.close();
        } catch { }
    }
    for (const t of recording.transports || []) {
        try {
            t.close();
        } catch { }
    }
    for (const p of recording.ports || []) releaseRecordingPort(p);
    recording.consumers = [];
    recording.transports = [];
    recording.ports = [];
    if (recording.sdpPath) {
        await fs.rm(recording.sdpPath, { force: true }).catch((err) => warn(`Failed to delete SDP (${path.basename(recording.sdpPath)}): ${err.message}`));
    }
}

/** Resolves video settings for a recording; unknown or missing quality uses the env defaults. */
function resolveVideoSettings(quality) {
    const base = {
        videoQuality: "default",
        mode: RECORDING_VIDEO_MODE,
        bitrate: RECORDING_VIDEO_BITRATE,
        crf: RECORDING_VIDEO_CRF,
        preset: RECORDING_VIDEO_PRESET,
        maxWidth: RECORDING_MAX_WIDTH,
        maxHeight: RECORDING_MAX_HEIGHT,
    };

    if (quality === undefined || quality === null || quality === "") return base;

    const video_quality = String(quality).trim().toLowerCase();
    if (!Object.hasOwn(RECORDING_QUALITY_PROFILES, video_quality)) {
        warn(`Unknown recording quality "${quality}" (use high, medium or low); using default.`);
        return base;
    }

    return { ...base, ...RECORDING_QUALITY_PROFILES[video_quality], videoQuality: video_quality };
}

/** Video output args. COPY = no quality loss. ENCODE = re-encode with the given settings. */
function buildRecordingVideoArgs(settings) {
    if (settings.mode !== "encode") {
        return ["-c:v", "copy"];
    }

    const args = [];

    if (settings.maxWidth > 0 && settings.maxHeight > 0) {
        args.push(
            "-vf",
            `scale=${settings.maxWidth}:${settings.maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`
        );
    }

    const m = /^(\d+)([kKmM]?)$/.exec(settings.bitrate);
    const bufsize = m ? `${Number(m[1]) * 2}${m[2]}` : "12000k";

    args.push(
        "-c:v", "libx264",
        "-preset", settings.preset,
        "-crf", settings.crf,
        "-maxrate", settings.bitrate,
        "-bufsize", bufsize,
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-sc_threshold", "0"
    );

    return args;
}

/** Ask FFmpeg to quit cleanly ("q" on stdin), then escalate. */
function stopFfmpegProcess(child, { gracefulMs = 5000 } = {}) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();

        const killTimer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch { }
            resolve();
        }, gracefulMs);

        child.once("close", () => {
            clearTimeout(killTimer);
            resolve();
        });

        try {
            child.stdin.write("q\n");
            child.stdin.end();
        } catch {
            try {
                child.kill("SIGINT");
            } catch { }
        }
    });
}

async function postRecordingStatus(url, body, label) {
    if (!url) {
        warn(`${label} skipped: API URL not configured`);
        return;
    }
    try {
        const token = await storage.ensureValidToken();
        const headers = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) log(`${label} sent for user ${body.userId}`);
        else warn(`${label} failed with status ${response.status}`);
    } catch (err) {
        error(`${label} error: ${err.message}`);
    }
}

async function startRecording(orgId, roomName, room, streamKey, meta, quality) {
    if (room.recordings.has(streamKey)) {
        const existing = room.recordings.get(streamKey);
        return {
            ok: true,
            alreadyRecording: Boolean(existing.ready),
            status: existing.ready ? "recording" : "starting",
            recordingPath: existing.outputPath,
        };
    }

    const videoSettings = resolveVideoSettings(quality);

    const sourceProducers = [
        { kind: "video", id: meta.videoProducerId },
        { kind: "audio", id: RECORDING_AUDIO_ENABLED ? meta.audioProducerId : null },
    ]
        .map((t) => ({ ...t, producer: t.id ? room.producers.get(t.id) : null }))
        .filter((t) => t.producer && !t.producer.closed);

    if (!sourceProducers.length) {
        return { error: "No active media producers found for this stream" };
    }

    const startedDate = new Date();
    const userEmail = meta.userEmail || "bhuvi@test.com";
    const filename = recordingFileName(startedDate, "ts");
    const recordingDir = getRecordingDir(orgId, userEmail, startedDate);
    const outputPath = path.join(recordingDir, filename);

    const recording = {
        orgId,
        roomName,
        streamKey,
        targetUserId: meta.targetUserId,
        outputPath,
        filename,
        consumers: [],
        transports: [],
        ports: [],
        process: null,
        startedAt: Date.now(),
        stopping: false,
        sdpPath: null,
        ready: false,
        failureReported: false,
    };

    room.recordings.set(streamKey, recording);

    const checkCancelled = () => {
        if (recording.stopping) throw new Error("Recording startup cancelled");
    };

    try {
        await fs.mkdir(recordingDir, { recursive: true });
        debug(`[Recording] Directory created: ${recordingDir}`);
        checkCancelled();

        const entries = [];

        for (const track of sourceProducers) {
            const port = await allocateUdpPortPair();
            recording.ports.push(port);
            checkCancelled();

            // Local-only transport: FFmpeg is on the same machine.
            const transport = await room.router.createPlainTransport({
                listenIp: "127.0.0.1",
                rtcpMux: false,
                comedia: false,
                appData: { type: "recorder", orgId, roomName, streamKey, kind: track.kind },
            });
            recording.transports.push(transport);
            checkCancelled();

            const consumer = await transport.consume({
                producerId: track.producer.id,
                // Codecs only: no header extensions in the recorder RTP stream.
                rtpCapabilities: { codecs: room.router.rtpCapabilities.codecs },
                paused: true,
            });
            recording.consumers.push(consumer);
            checkCancelled();

            const codec = consumer.rtpParameters.codecs[0];
            if (!codec) throw new Error(`No negotiated ${track.kind} codec available for recording`);

            log(
                `Recording ${track.kind}: pt=${codec.payloadType} mime=${codec.mimeType} ` +
                `clock=${codec.clockRate} params=${JSON.stringify(codec.parameters || {})}`
            );

            entries.push({
                kind: track.kind,
                port,
                codec,
                spropParameterSets: codec.parameters?.["sprop-parameter-sets"] || null,
                transport,
                consumer,
            });
        }

        const sdpPath = path.join(RECORDINGS_DIR, `.${safeName(streamKey)}-${Date.now()}.sdp`);
        recording.sdpPath = sdpPath;

        const sdpContent = makeSdp(entries);
        log(`\n=== RECORDING SDP ===\n${sdpContent}=== END SDP ===`);
        await fs.writeFile(sdpPath, sdpContent, { mode: 0o600 });

        const hasAudio = entries.some((e) => e.kind === "audio");

        const args = [
            "-hide_banner",
            "-loglevel", process.env.FFMPEG_LOG_LEVEL || "info",

            "-protocol_whitelist", "file,udp,rtp",
            "-fflags", "+genpts",
            "-buffer_size", "33554432",
            "-reorder_queue_size", "256",
            "-max_delay", "500000",

            // Short probe: waiting 120s here is what made startup time out.
            "-analyzeduration", "10000000",
            "-probesize", "10000000",

            "-i", sdpPath,

            "-map", "0:v:0",
            ...(hasAudio ? ["-map", "0:a:0?"] : []),

            "-max_muxing_queue_size", "4096",

            ...buildRecordingVideoArgs(videoSettings),

            ...(hasAudio
                ? [
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-ar", "48000",
                    "-ac", "2",
                    "-af", "aresample=async=1:first_pts=0",
                ]
                : ["-an"]),

            "-f", "mpegts",
            "-metadata", `title=Recording ${streamKey}`,
            "-y",
            outputPath,
        ];

        if (videoSettings.mode !== "encode" && (videoSettings.maxWidth || videoSettings.maxHeight)) {
            warn("RECORDING_MAX_WIDTH/HEIGHT are ignored in copy mode (high quality or RECORDING_VIDEO_MODE=copy).");
        }

        log(`Starting FFmpeg recording: ${filename} (quality=${videoSettings.videoQuality}, video mode=${videoSettings.mode}, audio=${hasAudio ? "on" : "off"})`);

        const child = spawn(FFMPEG_PATH, args, { stdio: ["pipe", "ignore", "pipe"] });
        recording.process = child;
        child.stdin.on("error", () => { }); // ignore EPIPE when FFmpeg exits

        child.stderr.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line) warn(`FFmpeg [${filename}]: ${line}`);
        });

        child.once("close", (code, signal) => {
            if (recording.stopping) return;

            recording.stopping = true;
            recording.failureReported = true;

            error(`FFmpeg ended unexpectedly for ${filename}: code=${code}, signal=${signal}`);

            emitRoom(orgId, roomName, "recording-error", {
                orgId,
                roomName,
                fileName: filename,
                error: `FFmpeg exited unexpectedly (code ${code})`,
            });

            room.recordings.delete(streamKey);
            void disposeRecordingResources(recording);
            if (!recording.ready) void fs.rm(outputPath, { force: true }).catch(() => { });
        });

        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        checkCancelled();

        // FFmpeg has had time to bind its UDP ports; now point mediasoup at them.
        await sleep(300);
        checkCancelled();

        for (const entry of entries) {
            log(`Connecting ${entry.kind} recorder transport -> 127.0.0.1:${entry.port}`);
            await entry.transport.connect({ ip: "127.0.0.1", port: entry.port, rtcpPort: entry.port + 1 });
            checkCancelled();
            await entry.consumer.resume();
            checkCancelled();
            log(`Resumed ${entry.kind} recorder consumer ${entry.consumer.id}`);
        }

        const requestKeyframes = async (label) => {
            for (const entry of entries) {
                if (entry.kind !== "video") continue;
                try {
                    await entry.consumer.requestKeyFrame();
                    log(`Requested ${label} video keyframe`);
                } catch (err) {
                    warn(`${label} keyframe request failed:`, err?.message || err);
                }
            }
        };

        await requestKeyframes("initial");

        // Wait until FFmpeg actually writes data.
        const deadline = Date.now() + RECORDING_STARTUP_TIMEOUT_MS;
        let outputSize = 0;
        let lastKeyframeAt = Date.now();

        while (Date.now() < deadline) {
            checkCancelled();

            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`FFmpeg exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
            }

            try {
                const stat = await fs.stat(outputPath);
                outputSize = stat.size;
                if (outputSize > 0) {
                    log(`Recording output started: ${outputPath}; size=${outputSize} bytes`);
                    break;
                }
            } catch (e) {
                if (e.code !== "ENOENT") warn(`Recording output stat error: ${e.message}`);
            }

            // Re-ask for a keyframe every 3s while waiting (harmless if agent ignores PLI).
            if (Date.now() - lastKeyframeAt > 3000) {
                await requestKeyframes("fallback");
                lastKeyframeAt = Date.now();
            }

            await sleep(200);
        }

        if (!outputSize) {
            throw new Error(
                `No recording data was written within ${RECORDING_STARTUP_TIMEOUT_MS}ms. ` +
                `Make sure the agent sends H.264 with SPS/PPS repeated on every keyframe ` +
                `and a keyframe at least every 1-2 seconds.`
            );
        }

        recording.ready = true;

        void postRecordingStatus(ADD_RECORDING_API_URL, {
            organizationID: orgId,
            userId: meta.targetUserId,
            startTime: new Date(recording.startedAt).toISOString(),
        }, "Add recording");

        emitRoom(orgId, roomName, "recording-started", {
            orgId,
            roomName,
            agentId: meta.agentId,
            targetUserId: meta.targetUserId,
            recordingPath: outputPath,
            fileName: filename,
            startedAt: recording.startedAt,
            sizeBytes: outputSize,
            videoMode: videoSettings.mode,
            videoQuality: videoSettings.videoQuality,
        });

        log(`Recording started successfully: ${outputPath}`);

        return { ok: true, status: "recording", recordingPath: outputPath, fileName: filename };
    } catch (err) {
        room.recordings.delete(streamKey);

        const cancelled = recording.stopping && !recording.failureReported;
        recording.stopping = true;

        const child = recording.process;
        if (child && child.exitCode === null && child.signalCode === null) {
            await stopFfmpegProcess(child, { gracefulMs: 1500 });
        }

        await disposeRecordingResources(recording);
        await fs.rm(outputPath, { force: true }).catch(() => { });

        error("Failed to start recording:", err?.message || err);

        return {
            error: err?.message || String(err),
            cancelled,
            errorEventEmitted: recording.failureReported,
        };
    }
}

function beginRecording(orgId, roomName, room, streamKey, meta, quality) {
    const pending = startRecording(orgId, roomName, room, streamKey, meta, quality);

    const emitError = (message) =>
        emitRoom(orgId, roomName, "recording-error", {
            orgId,
            roomName,
            agentId: meta.agentId,
            targetUserId: meta.targetUserId,
            error: message,
        });

    pending
        .then((result) => {
            if (result?.error && !result.cancelled && !result.errorEventEmitted) {
                emitError(result.error);
            }
        })
        .catch((err) => {
            error("Recording startup rejected:", err?.stack || err);
            emitError(err?.message || String(err));
        });

    const recording = room.recordings.get(streamKey);
    return {
        ok: true,
        status: recording?.ready ? "recording" : "starting",
        recordingPath: recording?.outputPath || null,
    };
}

/* ------------------------------------------------------------------ */
/* TS -> MP4 (stream copy, no quality loss)                            */
/* ------------------------------------------------------------------ */

async function runMp4Conversion(tsFilePath, orgId, roomName) {
    const mp4FilePath = tsFilePath.replace(/\.ts$/i, ".mp4");
    const mp4Name = path.basename(mp4FilePath);

    const fail = (message) => {
        warn(`MP4 conversion failed (${mp4Name}): ${message}`);
        emitRoom(orgId, roomName, "recording-conversion-failed", {
            orgId,
            roomName,
            fileName: mp4Name,
            error: message,
        });
        return null;
    };

    try {
        const stats = await fs.stat(tsFilePath);
        if (stats.size === 0) {
            warn(`Skipping conversion: TS file is empty (${tsFilePath})`);
            return null;
        }

        log(`Converting TS to MP4 (stream copy): ${path.basename(tsFilePath)} -> ${mp4Name}`);

        // Scale timeout with file size: min 2 min, +1 min per 200 MB.
        const timeoutMs = 120_000 + Math.ceil(stats.size / (200 * 1024 * 1024)) * 60_000;

        return await new Promise((resolve) => {
            const ff = spawn(
                FFMPEG_PATH,
                [
                    "-hide_banner",
                    "-loglevel", "error",
                    "-i", tsFilePath,
                    "-map", "0:v:0",
                    "-map", "0:a:0?",
                    "-c", "copy",
                    "-bsf:a", "aac_adtstoasc",
                    "-movflags", "+faststart",
                    "-y",
                    mp4FilePath,
                ],
                { stdio: ["ignore", "ignore", "pipe"] }
            );

            const timeout = setTimeout(() => {
                try {
                    ff.kill("SIGKILL");
                } catch { }
                fail("Conversion timeout");
                resolve(null);
            }, timeoutMs);

            ff.stderr.on("data", (chunk) => {
                const line = chunk.toString().trim();
                if (line) warn(`FFmpeg conversion: ${line}`);
            });

            ff.once("error", (err) => {
                clearTimeout(timeout);
                fail(err.message);
                resolve(null);
            });

            ff.once("close", async (code) => {
                clearTimeout(timeout);

                if (code !== 0) {
                    fail(`FFmpeg exited with code ${code}`);
                    return resolve(null);
                }

                try {
                    const mp4Stats = await fs.stat(mp4FilePath);
                    log(`MP4 conversion successful: ${mp4Name} (${(mp4Stats.size / 1024).toFixed(1)} KB)`);

                    emitRoom(orgId, roomName, "recording-converted", {
                        orgId,
                        roomName,
                        tsFile: path.basename(tsFilePath),
                        mp4File: mp4Name,
                        fileSizeBytes: mp4Stats.size,
                    });

                    // Delete the TS file after successful MP4 conversion
                    try {
                        await fs.rm(tsFilePath);
                        log(`Deleted TS file: ${path.basename(tsFilePath)}`);
                    } catch (delErr) {
                        warn(`Failed to delete TS file: ${delErr.message}`);
                    }

                    if (RECORDING_PLAYBACK_COPY) {
                        await createPlaybackCopy(mp4FilePath).catch((err) => warn(`Playback copy error: ${err.message}`));
                    }
                    await ensureHlsForMp4(mp4FilePath).catch((err) =>
                        warn(`HLS preparation error (${mp4Name}): ${err.message}`)
                    );

                    resolve(mp4FilePath);
                } catch (statErr) {
                    error(`Failed to stat converted file: ${statErr.message}`);
                    resolve(null);
                }
            });
        });
    } catch (err) {
        error(`Conversion setup failed: ${err.message}`);
        return null;
    }
}

// Low-bitrate copy for playback; the original MP4 stays the download. Written to .part, renamed when complete.
async function createPlaybackCopy(mp4FilePath) {
    const playPath = playbackPathFor(mp4FilePath);
    const partPath = `${playPath}.part`;
    const playName = path.basename(playPath);
    const stats = await fs.stat(mp4FilePath);
    const timeoutMs = 600_000 + Math.ceil(stats.size / (200 * 1024 * 1024)) * 300_000;

    log(`Creating playback copy: ${playName}`);
    const ok = await new Promise((resolve) => {
        const ff = spawn(
            FFMPEG_PATH,
            [
                "-hide_banner",
                "-loglevel", "error",
                "-i", mp4FilePath,
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-vf", "scale=-2:480",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "28",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "96k",
                "-movflags", "+faststart",
                "-f", "mp4",
                "-y",
                partPath,
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
        );

        const timeout = setTimeout(() => {
            try {
                ff.kill("SIGKILL");
            } catch { }
            warn(`Playback copy timeout (${playName})`);
            resolve(false);
        }, timeoutMs);

        ff.stderr.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line) warn(`FFmpeg playback copy: ${line}`);
        });

        ff.once("error", (err) => {
            clearTimeout(timeout);
            warn(`Playback copy failed (${playName}): ${err.message}`);
            resolve(false);
        });

        ff.once("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0) warn(`Playback copy failed (${playName}): FFmpeg exited with code ${code}`);
            resolve(code === 0);
        });
    });

    if (!ok) {
        await fs.rm(partPath, { force: true });
        return false;
    }
    await fs.rename(partPath, playPath);
    log(`Playback copy ready: ${playName}`);
    return true;
}

function hlsDirForMp4(mp4Path) {
    return `${mp4Path}.hls-v2`;
}

/* One build per recording: concurrent requests share the in-flight job instead
   of spawning duplicate FFmpeg runs over the same output paths. */
const hlsBuilds = new Map();

async function hlsVariantReady(hlsRoot, key) {
    try {
        await fs.access(path.join(hlsRoot, `${key}.m3u8`));
        const items = await fs.readdir(path.join(hlsRoot, key));
        return items.some((name) => name.endsWith(".ts"));
    } catch {
        return false;
    }
}

async function readyHlsVariants(hlsRoot) {
    const keys = [];
    for (const variant of PLAYBACK_VARIANTS) {
        if (await hlsVariantReady(hlsRoot, variant.key)) keys.push(variant.key);
    }
    return keys;
}

/* Returns the HLS directory when renditions are already on disk; otherwise
   starts the build in the background and returns null, so the caller can answer
   immediately instead of holding the request open for the whole transcode. */
async function getReadyHlsRoot(mp4FilePath) {
    const hlsRoot = hlsDirForMp4(mp4FilePath);
    if ((await readyHlsVariants(hlsRoot)).length) return hlsRoot;

    if (!hlsBuilds.has(hlsRoot)) {
        const job = ensureHlsForMp4(mp4FilePath)
            .catch((err) => warn(`HLS build failed for ${mp4FilePath}: ${err.message}`))
            .finally(() => hlsBuilds.delete(hlsRoot));
        hlsBuilds.set(hlsRoot, job);
    }
    return null;
}

function respondHlsPreparing(res) {
    res.setHeader("Retry-After", "30");
    return res
        .status(503)
        .json({ error: "HLS renditions are being prepared", status: "preparing" });
}

function pickPlaybackVariant(variantName) {
    const normalized = String(variantName || "auto").toLowerCase();
    if (normalized === "auto") return "medium";
    return PLAYBACK_VARIANTS.some((v) => v.key === normalized) ? normalized : "medium";
}

async function ensureHlsForMp4(mp4FilePath) {
    const hlsRoot = hlsDirForMp4(mp4FilePath);
    await fs.mkdir(hlsRoot, { recursive: true });

    const built = [];
    for (const variant of PLAYBACK_VARIANTS) {
        const variantDir = path.join(hlsRoot, variant.key);
        const playlistPath = path.join(hlsRoot, `${variant.key}.m3u8`);
        const segmentPattern = path.join(variantDir, "segment_%03d.ts");

        let playlistExists = false;
        try {
            await fs.access(playlistPath);
            playlistExists = true;
        } catch { }

        if (playlistExists) {
            const items = await fs.readdir(variantDir).catch(() => []);
            if (items.length) {
                built.push(variant.key);
                continue;
            }
        }

        await fs.mkdir(variantDir, { recursive: true });
        const ff = spawn(
            FFMPEG_PATH,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                mp4FilePath,
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-vf",
                `scale=-2:${variant.height}`,
                "-c:v",
                "libx264",
                "-profile:v",
                "main",
                "-level:v",
                "4.1",
                "-preset",
                "veryfast",
                "-crf",
                variant.crf,
                "-maxrate",
                variant.bitrate,
                "-bufsize",
                variant.bufferSize,
                "-pix_fmt",
                "yuv420p",
                "-force_key_frames",
                "expr:gte(t,n_forced*6)",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-f",
                "hls",
                "-hls_time",
                "6",
                "-hls_playlist_type",
                "vod",
                "-hls_list_size",
                "0",
                "-hls_flags",
                "independent_segments",
                "-hls_segment_filename",
                segmentPattern,
                playlistPath,
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
        );

        const ok = await new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            ff.stderr.on("data", (chunk) => {
                const line = chunk.toString().trim();
                if (line) warn(`FFmpeg HLS ${variant.key}: ${line}`);
            });
            ff.once("error", (err) => {
                warn(`HLS generation failed for ${variant.key}: ${err.message}`);
                finish(false);
            });
            ff.once("close", (code) => {
                if (code !== 0) {
                    warn(`HLS generation failed for ${variant.key}: FFmpeg exited with code ${code}`);
                    finish(false);
                    return;
                }
                finish(true);
            });
        });
        if (ok) built.push(variant.key);
    }

    if (!built.length) throw new Error("no HLS renditions could be generated");

    // Advertise only the renditions that exist: listing a failed one leaves the
    // player requesting a playlist that was never written.
    const masterPath = path.join(hlsRoot, "master.m3u8");
    const masterContent = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        ...PLAYBACK_VARIANTS.filter((variant) => built.includes(variant.key)).map((variant) => {
            const bandwidth = Number.parseInt(variant.bitrate, 10) * 1000;
            return `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},CODECS="avc1.4d4029,mp4a.40.2"\n${variant.key}.m3u8`;
        }),
        "",
    ].join("\n");

    await fs.writeFile(masterPath, masterContent, "utf8");
    return hlsRoot;
}

async function streamHlsPlaylist(req, res, filePath, variantName) {
    const hlsRoot = await getReadyHlsRoot(filePath);
    if (!hlsRoot) return respondHlsPreparing(res);
    const requestedVariant = String(variantName || "auto").toLowerCase();
    const variant = requestedVariant === "auto" ? "medium" : pickPlaybackVariant(requestedVariant);
    const selected = requestedVariant === "auto" ? "master" : variant;
    const playlistPath = path.join(hlsRoot, selected === "master" ? "master.m3u8" : `${selected}.m3u8`);

    let manifest = await fs.readFile(playlistPath, "utf8");
    if (selected === "master") {
        manifest = manifest.replace(/(?:^|\n)(low|medium|high)\.m3u8/g, (_match, variantName) => {
            const variantUrl = `/api/recordings/playlist?${new URLSearchParams({
                orgId: req.query.orgId,
                email: req.query.email,
                date: req.query.date,
                name: req.query.name,
                sig: req.query.sig,
                variant: variantName,
            })}`;
            return `\n${variantUrl}`;
        });
    } else {
        manifest = manifest.replace(/(?:^|\n)([^#\n][^\n]*\.ts)/g, (_match, segmentName) => {
            const segmentUrl = `/api/recordings/hls?${new URLSearchParams({
                orgId: req.query.orgId,
                email: req.query.email,
                date: req.query.date,
                name: req.query.name,
                sig: req.query.sig,
                variant,
                segment: segmentName,
            })}`;
            return `\n${segmentUrl}`;
        });
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(manifest);
}

async function streamHlsSegment(req, res, filePath, variantName, segmentName) {
    const safeSegmentName = String(segmentName || "");
    if (!/^segment_\d+\.ts$/.test(safeSegmentName)) {
        return res.status(400).json({ error: "invalid segment name" });
    }
    const hlsRoot = await getReadyHlsRoot(filePath);
    if (!hlsRoot) return respondHlsPreparing(res);
    const requestedVariant = String(variantName || "auto").toLowerCase();
    const variant = requestedVariant === "auto" ? "medium" : pickPlaybackVariant(requestedVariant);
    const target = path.join(hlsRoot, variant, safeSegmentName);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
        return res.status(404).json({ error: "segment not found" });
    }
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(target, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).json({ error: err.message });
    });
}

/* ------------------------------------------------------------------ */
/* Background maintenance: retention + convert leftover TS files        */
/* ------------------------------------------------------------------ */

const RECORDING_DELETE_DAYS = int(process.env.RECORDING_DELETE_DAYS, 0);
const RECORDING_MAINTENANCE_INTERVAL_MS =
    int(process.env.RECORDING_MAINTENANCE_INTERVAL_MINUTES, 10) * 60_000;
const TS_MIN_AGE_MS = 2 * 60_000; // skip files still being written by FFmpeg

const conversionsInProgress = new Set();
let maintenanceRunning = false;
let maintenanceTimer = null;

function formatFolderDate(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

function formatFileStamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Returns the Date for a YYYY-MM-DD folder name, or null if it is not a real calendar date.
function parseFolderDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    return valid ? date : null;
}

function convertRecordingToMp4(tsFilePath, orgId, roomName) {
    if (conversionsInProgress.has(tsFilePath)) return Promise.resolve(null);
    conversionsInProgress.add(tsFilePath);
    return runMp4Conversion(tsFilePath, orgId, roomName).finally(() =>
        conversionsInProgress.delete(tsFilePath)
    );
}

const STORED_MARKER = ".uploaded";
const storesInProgress = new Set();
const pathExists = (p) => fs.access(p).then(() => true, () => false);

// Uploads a converted MP4 to the org's configured storage; failures are logged, not thrown.
async function storeConvertedRecording(mp4FilePath, orgId, roomName) {
    if (storesInProgress.has(mp4FilePath)) return null;
    storesInProgress.add(mp4FilePath);
    const mp4Name = path.basename(mp4FilePath);
    log(`Storing converted MP4 in org storage: ${mp4Name}`);
    try {
        const result = await storage.uploadRecordingFile(mp4FilePath, orgId, roomName);
        log(`Stored ${mp4Name} (provider: ${result?.provider ?? "unknown"}, local only: ${!!result?.local}, fallback: ${!!result?.fallback}${result?.originalError ? `, cloud error: ${result.originalError}` : ""})`);
        if (result?.ok && !result.local && !result.fallback) {
            // Marker is written first so a failed local delete is not re-uploaded.
            await fs.writeFile(`${mp4FilePath}${STORED_MARKER}`, new Date().toISOString());
            try {
                await fs.rm(mp4FilePath, { force: true });
                await fs.rm(`${mp4FilePath}${STORED_MARKER}`, { force: true });
                await fs.rm(playbackPathFor(mp4FilePath), { force: true });
                log(`Deleted local MP4 after cloud upload: ${mp4Name}`);
            } catch (delErr) {
                warn(`Failed to delete local MP4 (${mp4Name}): ${delErr.message}`);
            }
        }
        return result;
    } catch (err) {
        error(`Storage upload error (${mp4Name}): ${err.message}`);
        return null;
    } finally {
        storesInProgress.delete(mp4FilePath);
    }
}

// Uploads MP4s from earlier runs that have no upload marker yet.
async function storePendingUploads() {
    const skippedOrgs = new Set();
    for (const { orgId, recordingDir } of await listDateDirs()) {
        if (skippedOrgs.has(orgId)) continue;
        const names = await fs.readdir(recordingDir).catch(() => []);
        for (const name of names) {
            if (!/\.mp4$/i.test(name) || isPlaybackCopy(name)) continue;

            const mp4Path = path.join(recordingDir, name);
            const stats = await fs.stat(mp4Path).catch(() => null);
            if (!stats || Date.now() - stats.mtimeMs < TS_MIN_AGE_MS) continue;
            if (await pathExists(`${mp4Path}${STORED_MARKER}`)) continue;

            const result = await storeConvertedRecording(mp4Path, orgId, null);
            if (result?.local) {
                skippedOrgs.add(orgId);
                warn(`Upload sweep: no storage config for org ${orgId}, skipping its remaining MP4s this run`);
                break;
            }
        }
    }
}

function busyRecordingPaths() {
    const busy = new Set(conversionsInProgress);
    for (const orgRooms of rooms.values()) {
        for (const room of orgRooms.values()) {
            for (const recording of room.recordings.values()) {
                busy.add(recording.outputPath);
                if (recording.sdpPath) busy.add(recording.sdpPath);
            }
        }
    }
    return busy;
}

// Deletes SDP files left behind by a crash or restart; SDP files of active recordings are skipped.
async function sweepOrphanSdpFiles() {
    const names = await fs.readdir(RECORDINGS_DIR).catch(() => []);
    const busy = busyRecordingPaths();
    for (const name of names) {
        if (!/^\..*\.sdp$/i.test(name)) continue;
        const sdpPath = path.join(RECORDINGS_DIR, name);
        if (busy.has(sdpPath)) continue;
        const stats = await fs.stat(sdpPath).catch(() => null);
        if (!stats || Date.now() - stats.mtimeMs < TS_MIN_AGE_MS) continue;
        try {
            await fs.rm(sdpPath, { force: true });
            log(`Deleted orphan SDP file: ${name}`);
        } catch (err) {
            warn(`Failed to delete orphan SDP file (${name}): ${err.message}`);
        }
    }
}

async function listDateDirs() {
    const orgEntries = await fs
        .readdir(RECORDINGS_DIR, { withFileTypes: true })
        .catch((err) => {
            if (err.code === "ENOENT") return [];
            throw err;
        });

    const dateDirs = [];
    for (const org of orgEntries.filter((e) => e.isDirectory())) {
        const orgDir = path.join(RECORDINGS_DIR, org.name);
        const userEntries = await fs.readdir(orgDir, { withFileTypes: true });
        for (const user of userEntries.filter((e) => e.isDirectory())) {
            const userDir = path.join(orgDir, user.name);
            const dayEntries = await fs.readdir(userDir, { withFileTypes: true });
            for (const day of dayEntries) {
                const date = day.isDirectory() ? parseFolderDate(day.name) : null;
                if (!date) continue;
                const dir = path.join(userDir, day.name);
                dateDirs.push({ orgId: org.name, date, dir, recordingDir: path.join(dir, RECORDING_FOLDER) });
            }
        }
    }
    return dateDirs;
}

// Deletes the cloud copy of each uploaded MP4 in a folder; returns false if any failed so the folder is kept for retry.
async function deleteCloudCopies(orgId, recordingDir) {
    let ok = true;
    const names = await fs.readdir(recordingDir).catch(() => []);
    for (const name of names) {
        if (!/\.mp4$/i.test(name)) continue;
        const mp4Path = path.join(recordingDir, name);
        if (!(await pathExists(`${mp4Path}${STORED_MARKER}`))) continue;
        try {
            await storage.deleteRecordingFile(mp4Path, orgId);
            log(`Retention: deleted cloud copy of ${name}`);
        } catch (err) {
            ok = false;
            warn(`Retention: failed to delete cloud copy of ${name}: ${err.message}`);
        }
    }
    return ok;
}

async function applyRetention() {
    if (RECORDING_DELETE_DAYS <= 0) return;

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - RECORDING_DELETE_DAYS);
    const busy = busyRecordingPaths();

    for (const { orgId, date, dir, recordingDir } of await listDateDirs()) {
        if (date > cutoff) continue;
        if ([...busy].some((p) => p.startsWith(dir + path.sep))) continue;
        if (!(await deleteCloudCopies(orgId, recordingDir))) continue;
        try {
            await fs.rm(dir, { recursive: true, force: true });
            log(`Retention: deleted recordings folder ${dir}`);
        } catch (err) {
            warn(`Retention: failed to delete ${dir}: ${err.message}`);
        }
    }
}

async function convertPendingRecordings() {
    const exists = (p) => fs.access(p).then(() => true, () => false);

    for (const { orgId, recordingDir } of await listDateDirs()) {
        const names = await fs.readdir(recordingDir).catch(() => []);
        for (const name of names) {
            if (!/\.ts$/i.test(name)) continue;

            const tsPath = path.join(recordingDir, name);
            if (busyRecordingPaths().has(tsPath)) continue;

            const stats = await fs.stat(tsPath).catch(() => null);
            if (!stats || Date.now() - stats.mtimeMs < TS_MIN_AGE_MS) continue;
            if (await exists(tsPath.replace(/\.ts$/i, ".mp4"))) continue;

            const mp4Path = await convertRecordingToMp4(tsPath, orgId, null);
            if (mp4Path) await storeConvertedRecording(mp4Path, orgId, null);
        }
    }
}

async function runRecordingMaintenance() {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
        await sweepOrphanSdpFiles();
        await applyRetention();
        await convertPendingRecordings();
        await storePendingUploads();
    } catch (err) {
        error(`Recording maintenance failed: ${err.message}`);
    } finally {
        maintenanceRunning = false;
    }
}

async function stopRecording(orgId, roomName, room, streamKey, reason = "requested") {
    const recording = room?.recordings.get(streamKey);

    if (!recording) return { ok: true, alreadyStopped: true };
    if (recording.stopping) {
        return { ok: true, stopping: true, recordingPath: recording.outputPath };
    }

    recording.stopping = true;
    room.recordings.delete(streamKey);

    // Stop feeding FFmpeg first, then let it finalise the file.
    for (const c of recording.consumers) {
        try {
            c.pause();
        } catch { }
    }

    await stopFfmpegProcess(recording.process, { gracefulMs: 8000 });

    let fileSizeBytes = 0;
    if (recording.ready) {
        try {
            fileSizeBytes = (await fs.stat(recording.outputPath)).size;
        } catch { }
    }

    await disposeRecordingResources(recording);

    const payload = {
        orgId,
        roomName,
        agentId: recording.streamKey.split(":")[0],
        recordingPath: recording.outputPath,
        fileName: recording.filename,
        durationMs: Date.now() - recording.startedAt,
        reason,
        wasReady: recording.ready,
        fileSizeBytes,
    };

    if (!recording.ready) {
        await fs.rm(recording.outputPath, { force: true }).catch(() => { });
    }

    emitRoom(orgId, roomName, "recording-stopped", payload);
    log(`Recording stopped (${reason}): ${recording.outputPath}`);

    if (recording.ready) {
        void postRecordingStatus(UPDATE_RECORDING_API_URL, {
            organizationID: orgId,
            userId: recording.targetUserId,
            status: "completed",
        }, "Update recording");
    }

    if (recording.ready && recording.outputPath.endsWith(".ts")) {
        void convertRecordingToMp4(recording.outputPath, orgId, roomName)
            .then((mp4Path) => mp4Path && storeConvertedRecording(mp4Path, orgId, roomName))
            .catch((err) => error(`Unexpected error in MP4 conversion: ${err.message}`));
    }

    return { ok: true, ...payload };
}

/* ------------------------------------------------------------------ */
/* Stream stop                                                         */
/* ------------------------------------------------------------------ */

async function stopStream(orgId, roomName, room, opts = {}) {
    if (!room) return;

    const matches = (meta) =>
        (!opts.agentId || meta.agentId === opts.agentId) &&
        (!opts.targetUserId || meta.targetUserId === opts.targetUserId);

    const keys = [...room.activeStreams.entries()].filter(([, m]) => matches(m)).map(([k]) => k);

    for (const key of keys) {
        await stopRecording(orgId, roomName, room, key, "stream-stopped");
    }

    for (const [id, producer] of [...room.producers.entries()]) {
        const d = producer.appData || {};
        if (opts.agentId && d.agentId !== opts.agentId) continue;
        if (opts.targetUserId && d.targetUserId !== opts.targetUserId) continue;
        try {
            producer.close();
        } catch { }
        room.producers.delete(id);
    }

    for (const [id, transport] of [...room.transports.entries()]) {
        const d = transport.appData || {};
        if (d.type === "consumer" || d.type === "recorder") continue;
        if (opts.agentId && d.agentId !== opts.agentId) continue;
        if (opts.targetUserId && d.targetUserId !== opts.targetUserId) continue;
        try {
            transport.close();
        } catch { }
        room.transports.delete(id);
    }

    for (const key of keys) room.activeStreams.delete(key);

    emitRoom(orgId, roomName, "stream-stopped", {
        orgId,
        roomName,
        agentId: opts.agentId || null,
        targetUserId: opts.targetUserId || null,
    });
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

function onlineAgentList(orgId) {
    return Array.from(agents.get(orgId) || [], ([agentId, socketId]) => ({
        userId: agentId,
        socketId,
        agentId,
    }));
}

function broadcastOnlineAgents(orgId) {
    io.to(`org:${orgId}`).emit("online-agent-users", { orgId, users: onlineAgentList(orgId) });
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
    const { role, orgId, userId, agentId } = socket.handshake.query || {};

    if (!orgId) {
        warn("Rejecting socket with missing orgId", socket.id);
        socket.disconnect(true);
        return;
    }

    socket.join(`org:${orgId}`);

    if (role === "admin") {
        ensureSet(admins, orgId).add(socket.id);
        socket.emit("online-agent-users", { orgId, users: onlineAgentList(orgId) });
        socket.on("disconnect", () => admins.get(orgId)?.delete(socket.id));
        return;
    }

    const replaceUserSocket = () => {
        const key = userId || agentId;
        const userSockets = ensureSet(ensureMap(onlineUsers, orgId), key);
        for (const oldId of userSockets) {
            if (oldId !== socket.id) io.sockets.sockets.get(oldId)?.disconnect(true);
        }
        userSockets.clear();
        userSockets.add(socket.id);
    };

    if (role === "agent") {
        if (!agentId) {
            socket.disconnect(true);
            return;
        }

        const orgAgents = ensureMap(agents, orgId);
        const previous = orgAgents.get(agentId);
        if (previous && previous !== socket.id) io.sockets.sockets.get(previous)?.disconnect(true);
        orgAgents.set(agentId, socket.id);

        replaceUserSocket();
        broadcastOnlineAgents(orgId);
    } else if (userId) {
        replaceUserSocket();
        io.to(`org:${orgId}`).emit("user-online", { orgId, userId });
    }

    socket.on("ffmpeg-started", (payload = {}) => {
        emitRoom(payload.orgId || orgId, payload.roomName, "producer-ready", { ...payload, ready: true });
    });

    socket.on("ffmpeg-error", (payload = {}) => {
        emitRoom(orgId, payload.roomName, "producer-error", payload);
    });

    /* ---------------- request-start-stream ---------------- */
    socket.on("request-start-stream", async (payload = {}, callback) => {
        const { targetUserId, roomName, preferredAgentId, provider, userEmail, quality } = payload;
        let room = null;
        let selectedAgentId = null;

        try {
            if (!targetUserId || !roomName) {
                return reply(callback, { error: "targetUserId and roomName are required" });
            }

            const targetSockets = onlineUsers.get(orgId)?.get(targetUserId);
            if (!targetSockets?.size) return reply(callback, { error: "Target user offline" });

            const orgAgents = agents.get(orgId);
            if (!orgAgents?.size) {
                return reply(callback, { error: "No agents available for this organization" });
            }

            selectedAgentId =
                preferredAgentId && orgAgents.has(preferredAgentId)
                    ? preferredAgentId
                    : orgAgents.keys().next().value;

            const agentSocketId = orgAgents.get(selectedAgentId);
            if (!agentSocketId) return reply(callback, { error: "No available agent socket" });

            room = await createRoom(orgId, roomName);
            const streamKey = makeStreamKey(selectedAgentId, targetUserId, roomName);

            if (room.activeStreams.has(streamKey)) {
                await stopStream(orgId, roomName, room, { agentId: selectedAgentId, targetUserId });
            }

            const makePlain = (type) =>
                room.router.createPlainTransport({
                    listenIp: { ip: "0.0.0.0", announcedIp: PUBLIC_ANNOUNCED_IP },
                    rtcpMux: true,
                    comedia: true,
                    appData: { type, orgId, roomName, agentId: selectedAgentId, targetUserId },
                });

            const videoTransport = await makePlain("plain-video");
            const audioTransport = await makePlain("plain-audio");

            for (const t of [videoTransport, audioTransport]) {
                room.transports.set(t.id, t);
                t.on("close", () => room.transports.delete(t.id));
            }

            const videoSsrc = (Date.now() % 100_000) + Math.floor(Math.random() * 9_000) + 1_000;
            const audioSsrc = videoSsrc + 10_000;

            const videoPort = resolvePortFromTransport(videoTransport);
            const audioPort = resolvePortFromTransport(audioTransport);
            if (!videoPort || !audioPort) throw new Error("Unable to resolve mediasoup RTP ports");

            // Attach RTP waiters BEFORE telling the agent to start sending.
            const videoOptions = {
                kind: "video",
                rtpParameters: {
                    codecs: [
                        {
                            mimeType: "video/H264",
                            clockRate: 90_000,
                            payloadType: 102,
                            parameters: { "packetization-mode": 1, "profile-level-id": "42e01f" },
                            rtcpFeedback: [
                                { type: "nack" },
                                { type: "nack", parameter: "pli" },
                                { type: "ccm", parameter: "fir" },
                                { type: "transport-cc" },
                            ],
                        },
                    ],
                    encodings: [{ ssrc: videoSsrc }],
                    rtcp: { cname: `video-${Date.now()}` },
                },
                appData: { kind: "video", orgId, roomName, agentId: selectedAgentId, targetUserId },
            };

            const audioOptions = {
                kind: "audio",
                rtpParameters: {
                    codecs: [{ mimeType: "audio/opus", clockRate: 48_000, channels: 2, payloadType: 100 }],
                    encodings: [{ ssrc: audioSsrc }],
                    rtcp: { cname: `audio-${Date.now()}` },
                },
                appData: { kind: "audio", orgId, roomName, agentId: selectedAgentId, targetUserId },
            };

            const producersPromise = Promise.all([
                waitForProducer({ room, transport: videoTransport, rtpOptions: videoOptions, kind: "video" }),
                waitForProducer({ room, transport: audioTransport, rtpOptions: audioOptions, kind: "audio" }),
            ]);

            io.to(agentSocketId).emit("start-ffmpeg", {
                orgId,
                roomName,
                targetUserId,
                agentId: selectedAgentId,
                provider: provider || "default",
                video: {
                    rtpPort: videoPort,
                    announcedIp: PUBLIC_ANNOUNCED_IP,
                    payloadType: 102,
                    ssrc: videoSsrc,
                },
                audio: {
                    rtpPort: audioPort,
                    announcedIp: PUBLIC_ANNOUNCED_IP,
                    payloadType: 100,
                    ssrc: audioSsrc,
                },
            });

            for (const sid of targetSockets) {
                io.to(sid).emit("stream-starting", {
                    orgId,
                    roomName,
                    agentId: selectedAgentId,
                    message: "Waiting for video stream...",
                });
            }

            const [videoProducer, audioProducer] = await producersPromise;

            const meta = {
                agentId: selectedAgentId,
                targetUserId,
                roomName,
                userEmail: userEmail || "unknown",
                videoProducerId: videoProducer?.id || null,
                audioProducerId: audioProducer?.id || null,
                createdAt: Date.now(),
            };

            if (!meta.videoProducerId && !meta.audioProducerId) {
                notifyAgent(orgId, selectedAgentId, "stop-ffmpeg", { orgId, roomName, targetUserId });
                await stopStream(orgId, roomName, room, { agentId: selectedAgentId, targetUserId });
                return reply(callback, { error: "No RTP received from the agent" });
            }

            room.activeStreams.set(streamKey, meta);

            emitRoom(orgId, roomName, "newProducer", {
                videoProducerId: meta.videoProducerId,
                audioProducerId: meta.audioProducerId,
                kind: "video",
                agentId: selectedAgentId,
                provider: provider || "default",
                targetUserId,
            });

            for (const sid of targetSockets) {
                io.to(sid).emit("stream-ready", {
                    orgId,
                    roomName,
                    videoProducerId: meta.videoProducerId,
                    audioProducerId: meta.audioProducerId,
                });
            }

            let recording = { ok: false, status: "disabled" };
            if (AUTO_RECORD) recording = beginRecording(orgId, roomName, room, streamKey, meta, quality);

            return reply(callback, {
                ok: true,
                orgId,
                roomName,
                videoProducerId: meta.videoProducerId,
                audioProducerId: meta.audioProducerId,
                agentId: selectedAgentId,
                targetUserId,
                recording,
            });
        } catch (err) {
            error("request-start-stream failed:", err?.stack || err);
            if (room && selectedAgentId) {
                notifyAgent(orgId, selectedAgentId, "stop-ffmpeg", { orgId, roomName, targetUserId });
                await stopStream(orgId, roomName, room, { agentId: selectedAgentId, targetUserId }).catch(() => { });
            }
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- request-stop-stream ---------------- */
    socket.on("request-stop-stream", async (payload = {}, callback) => {
        const { targetUserId, roomName, agentId: requestedAgentId } = payload;

        try {
            if (!roomName) return reply(callback, { error: "roomName required" });

            const room = rooms.get(orgId)?.get(roomName);
            if (!room) return reply(callback, { ok: true, alreadyStopped: true });

            const agentIds = requestedAgentId
                ? [requestedAgentId]
                : [
                    ...new Set(
                        [...room.activeStreams.values()]
                            .filter((m) => !targetUserId || m.targetUserId === targetUserId)
                            .map((m) => m.agentId)
                    ),
                ];

            for (const id of agentIds) {
                notifyAgent(orgId, id, "stop-ffmpeg", { orgId, roomName, targetUserId });
            }

            await stopStream(orgId, roomName, room, { agentId: requestedAgentId, targetUserId });
            return reply(callback, { ok: true });
        } catch (err) {
            error("request-stop-stream failed:", err);
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- request-start-recording ---------------- */
    socket.on("request-start-recording", async (payload = {}, callback) => {
        const { roomName, targetUserId, agentId: requestedAgentId, quality } = payload;

        try {
            if (!roomName || !targetUserId) {
                return reply(callback, { error: "roomName and targetUserId are required" });
            }

            const room = rooms.get(orgId)?.get(roomName);
            if (!room) return reply(callback, { error: "Room not found" });

            const entry = [...room.activeStreams.entries()].find(
                ([, meta]) =>
                    meta.targetUserId === targetUserId &&
                    (!requestedAgentId || meta.agentId === requestedAgentId)
            );
            if (!entry) return reply(callback, { error: "No active stream matches this target" });

            return reply(callback, beginRecording(orgId, roomName, room, entry[0], entry[1], quality));
        } catch (err) {
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- request-stop-recording ---------------- */
    socket.on("request-stop-recording", async (payload = {}, callback) => {
        const { roomName, targetUserId, agentId: requestedAgentId } = payload;

        try {
            const room = rooms.get(orgId)?.get(roomName);
            if (!room) return reply(callback, { error: "Room not found" });

            const entries = [...room.recordings.entries()].filter(([, rec]) => {
                const [recAgent, recTarget] = rec.streamKey.split(":");
                return (
                    (!targetUserId || recTarget === targetUserId) &&
                    (!requestedAgentId || recAgent === requestedAgentId)
                );
            });

            if (!entries.length) return reply(callback, { ok: true, alreadyStopped: true });

            const results = [];
            for (const [key] of entries) {
                results.push(await stopRecording(orgId, roomName, room, key));
            }
            return reply(callback, { ok: true, recordings: results });
        } catch (err) {
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- joinRoom ---------------- */
    socket.on("joinRoom", async (payload = {}, callback) => {
        try {
            if (!payload.roomName) return reply(callback, { error: "roomName required" });

            const room = await createRoom(orgId, payload.roomName);
            socket.join(`org:${orgId}:room:${payload.roomName}`);

            return reply(callback, { rtpCapabilities: room.router.rtpCapabilities });
        } catch (err) {
            error("joinRoom failed:", err);
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- createConsumerTransport ---------------- */
    socket.on("createConsumerTransport", async (payload = {}, callback) => {
        try {
            const room = rooms.get(orgId)?.get(payload.roomName);
            if (!room) return reply(callback, { error: "Room not found" });

            const transport = await room.router.createWebRtcTransport({
                listenIps: [{ ip: "0.0.0.0", announcedIp: PUBLIC_ANNOUNCED_IP }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: VIEWER_BITRATE,
                appData: {
                    type: "consumer",
                    socketId: socket.id,
                    connected: false,
                    orgId,
                    roomName: payload.roomName,
                    consumedProducers: new Set(),
                },
            });

            room.transports.set(transport.id, transport);
            transport.on("close", () => room.transports.delete(transport.id));

            try {
                await transport.setMaxIncomingBitrate(VIEWER_MAX_INCOMING_BITRATE);
            } catch (err) {
                warn("Unable to set consumer transport max incoming bitrate:", err?.message || err);
            }

            return reply(callback, {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (err) {
            error("createConsumerTransport failed:", err);
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    const findConsumerTransport = (room) =>
        [...room.transports.values()].find(
            (t) => t.appData?.type === "consumer" && t.appData.socketId === socket.id
        );

    /* ---------------- connectConsumerTransport ---------------- */
    socket.on("connectConsumerTransport", async (payload = {}, callback) => {
        try {
            const room = rooms.get(orgId)?.get(payload.roomName);
            if (!room) return reply(callback, { error: "Room not found" });

            const transport = findConsumerTransport(room);
            if (!transport) return reply(callback, { error: "Transport not found" });

            if (!transport.appData.connected) {
                await transport.connect({ dtlsParameters: payload.dtlsParameters });
                transport.appData.connected = true;
            }

            return reply(callback, { ok: true });
        } catch (err) {
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- consume ---------------- */
    socket.on("consume", async (payload = {}, callback) => {
        try {
            const room = rooms.get(orgId)?.get(payload.roomName);
            if (!room) return reply(callback, { error: "Room not found" });

            const transport = findConsumerTransport(room);
            if (!transport) return reply(callback, { error: "Consumer transport not found" });

            const consumed = transport.appData.consumedProducers;
            const consumers = [];

            for (const producer of room.producers.values()) {
                if (!producer || producer.closed || consumed.has(producer.id)) continue;
                if (
                    !room.router.canConsume({
                        producerId: producer.id,
                        rtpCapabilities: payload.rtpCapabilities,
                    })
                ) {
                    continue;
                }

                try {
                    const consumer = await transport.consume({
                        producerId: producer.id,
                        rtpCapabilities: payload.rtpCapabilities,
                        paused: true,
                    });

                    consumed.add(producer.id);
                    room.consumers.set(consumer.id, consumer);

                    consumer.on("transportclose", () => room.consumers.delete(consumer.id));
                    consumer.on("producerclose", () => {
                        consumed.delete(consumer.producerId);
                        try {
                            consumer.close();
                        } catch { }
                        room.consumers.delete(consumer.id);
                    });

                    await consumer.resume();

                    consumers.push({
                        id: consumer.id,
                        producerId: consumer.producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    });
                } catch (err) {
                    warn(`Consume failed for producer ${producer.id}:`, err?.message || err);
                }
            }

            return reply(callback, { consumers });
        } catch (err) {
            error("consume failed:", err);
            return reply(callback, { error: err?.message || String(err) });
        }
    });

    /* ---------------- disconnect ---------------- */
    socket.on("disconnect", async () => {
        try {
            const userMap = onlineUsers.get(orgId);
            const key = userId || agentId;

            if (key && role !== "agent" && userMap?.has(key)) {
                const sockets = userMap.get(key);
                sockets.delete(socket.id);

                if (!sockets.size) {
                    userMap.delete(key);
                    io.to(`org:${orgId}`).emit("user-offline", { orgId, userId: key });

                    for (const [roomName, room] of rooms.get(orgId) || []) {
                        const keys = [...room.activeStreams.entries()]
                            .filter(([, meta]) => meta.targetUserId === key)
                            .map(([k]) => k);

                        for (const k of keys) {
                            const meta = room.activeStreams.get(k);
                            notifyAgent(orgId, meta.agentId, "stop-ffmpeg", { orgId, roomName, targetUserId: key });
                            await stopStream(orgId, roomName, room, { agentId: meta.agentId, targetUserId: key });
                        }
                    }
                }
            }

            for (const [id, registeredSocket] of agents.get(orgId) || []) {
                if (registeredSocket !== socket.id) continue;

                agents.get(orgId).delete(id);
                onlineUsers.get(orgId)?.delete(userId || id);
                broadcastOnlineAgents(orgId);

                for (const [roomName, room] of rooms.get(orgId) || []) {
                    const keys = [...room.activeStreams.entries()]
                        .filter(([, meta]) => meta.agentId === id)
                        .map(([k]) => k);

                    for (const k of keys) {
                        const meta = room.activeStreams.get(k);
                        await stopStream(orgId, roomName, room, {
                            agentId: id,
                            targetUserId: meta.targetUserId,
                        });
                    }
                }
            }

            for (const orgRooms of rooms.values()) {
                for (const room of orgRooms.values()) {
                    for (const [id, transport] of [...room.transports.entries()]) {
                        if (transport.appData?.socketId === socket.id) {
                            try {
                                transport.close();
                            } catch { }
                            room.transports.delete(id);
                        }
                    }
                }
            }
        } catch (err) {
            error("disconnect cleanup failed:", err?.stack || err);
        }
    });
});

/* ------------------------------------------------------------------ */
/* Shutdown / listen                                                   */
/* ------------------------------------------------------------------ */

async function shutdown(signal) {
    log(`Received ${signal}; stopping recordings and closing mediasoup workers.`);
    clearInterval(maintenanceTimer);

    // Hard exit if cleanup hangs.
    setTimeout(() => process.exit(1), 20_000).unref();

    for (const [orgId, orgRooms] of rooms) {
        for (const [roomName, room] of orgRooms) {
            for (const key of [...room.recordings.keys()]) {
                await stopRecording(orgId, roomName, room, key, signal);
            }
            try {
                room.router.close();
            } catch { }
        }
    }

    for (const worker of workers) {
        try {
            worker.close();
        } catch { }
    }

    httpServer.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

httpServer.listen(PORT, "0.0.0.0", () => {
    log(`Server listening on 0.0.0.0:${PORT}`);
    log(`Viewer bitrate: ${VIEWER_BITRATE}`);
    log(`Recording video mode: ${RECORDING_VIDEO_MODE}`);
    log(`Recording directory: ${RECORDINGS_DIR}`);
    log(`Recording retention: ${RECORDING_DELETE_DAYS > 0 ? `${RECORDING_DELETE_DAYS} days` : "disabled"}`);
    void runRecordingMaintenance();
    maintenanceTimer = setInterval(
        () => void runRecordingMaintenance(),
        RECORDING_MAINTENANCE_INTERVAL_MS
    );
});
