import express from "express";
import { spawn, execSync, exec } from "child_process";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough, Readable } from "stream";
import yts from "yt-search";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import googleTTS from "google-tts-api";
import ffmpegStatic from "ffmpeg-static";
import session from "express-session";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import dotenv from "dotenv";
import { registerLiveLogs } from "./live_logs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env explicitly from script directory and current working directory with override: true
if (fs.existsSync(path.join(__dirname, ".env"))) {
  dotenv.config({ path: path.join(__dirname, ".env"), override: true });
}
if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  dotenv.config({ path: path.join(process.cwd(), ".env"), override: true });
}
dotenv.config({ override: true });

// Process Crash Guardian - Prevents unhandled errors from terminating the server
process.on('uncaughtException', (err) => {
  console.error('💥 [Crash Guardian] Uncaught Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 [Crash Guardian] Unhandled Rejection at:', promise, 'reason:', reason);
});


const app = express();
app.set("trust proxy", 1);
app.use(express.json());

let resolvedFfmpegPath = null;

function getFFmpegPath() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;

  // 1. Explicit environment variable
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    resolvedFfmpegPath = process.env.FFMPEG_PATH;
    console.log(`🎬 Using FFmpeg from FFMPEG_PATH: ${resolvedFfmpegPath}`);
    return resolvedFfmpegPath;
  }

  // 2. Check ffmpeg-static package
  if (ffmpegStatic && typeof ffmpegStatic === "string" && fs.existsSync(ffmpegStatic)) {
    try {
      if (process.platform !== "win32") {
        try { fs.chmodSync(ffmpegStatic, 0o755); } catch (e) {}
      }
      resolvedFfmpegPath = ffmpegStatic;
      console.log(`🎬 Using FFmpeg from ffmpeg-static: ${resolvedFfmpegPath}`);
      return resolvedFfmpegPath;
    } catch (e) {}
  }

  // 3. Check system PATH via which/where
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const systemPath = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (systemPath && fs.existsSync(systemPath)) {
      resolvedFfmpegPath = systemPath;
      console.log(`🎬 Using system FFmpeg: ${resolvedFfmpegPath}`);
      return resolvedFfmpegPath;
    }
  } catch (e) {}

  // 4. Common standard Linux/Unix installation locations
  const commonPaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/bin/ffmpeg",
    "/usr/lib/ffmpeg"
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      resolvedFfmpegPath = p;
      console.log(`🎬 Using FFmpeg at standard path: ${resolvedFfmpegPath}`);
      return resolvedFfmpegPath;
    }
  }

  // 5. Fallback: return 'ffmpeg' and let OS resolve from PATH
  resolvedFfmpegPath = "ffmpeg";
  console.log(`🎬 Falling back to 'ffmpeg' from PATH`);
  return resolvedFfmpegPath;
}

ffmpeg.setFfmpegPath(getFFmpegPath());

app.use(express.static(path.join(__dirname, "public")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 86400000 } // 24h
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per windowMs
  message: { error: "Too many login attempts, please try again later." }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 180, // 180 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." }
});

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (timingSafeCompare(token, ADMIN_PASSWORD)) {
      return next();
    }
  }

  const queryToken = (req.query.token || req.query.auth || '').trim();
  if (queryToken && timingSafeCompare(queryToken, ADMIN_PASSWORD)) {
    return next();
  }
  
  res.status(401).send({ error: "Unauthorized" });
};

// Global rate limiter (exempting live audio streaming)
app.use((req, res, next) => {
  const p = req.path.toLowerCase(); if (p === '/stream' || p.startsWith('/stream') || p.startsWith('/logs') || p.startsWith('/api/logs')) {
    return next();
  }
  return apiLimiter(req, res, next);
});

// GLOBAL DENY-BY-DEFAULT AUTH
app.use((req, res, next) => {
  // Allow public endpoints
  const p2 = req.path.toLowerCase(); if (p2 === '/api/login' || p2 === '/stream' || p2.startsWith('/stream') || p2.startsWith('/logs') || p2.startsWith('/api/logs') || p2 === '/health' || p2 === '/ping' || p2 === '/debug-ytdlp' || p2 === '/debug-exec') {
    return next();
  }
  // Enforce auth for everything else not caught by express.static
  return requireAuth(req, res, next);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()), isPlaying, currentTitle });
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.get("/debug-exec", (req, res) => {
  const cmd = req.query.cmd;
  if (!cmd) return res.status(400).send("No cmd parameter provided.");
  exec(cmd, { timeout: 25000, encoding: "utf8" }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).type("text/plain").send(`ERR: ${err.message}\nSTDOUT: ${stdout || ''}\nSTDERR: ${stderr || ''}`);
    }
    res.type("text/plain").send(stdout || stderr || "(completed with empty output)");
  });
});

app.get("/debug-ytdlp", async (req, res) => {
  const testUrl = req.query.url || 'https://youtube.com/watch?v=NPRd7Xc0tfM';
  const outTest = path.join(CACHE_DIR, `debug_${Date.now()}.m4a`);
  
  const results = {
    platform: process.platform,
    pythonCmd: PYTHON_CMD,
    ytdlpPath: YTDLP_PATH,
    ytdlpExists: fs.existsSync(YTDLP_PATH),
    ytdlpSize: fs.existsSync(YTDLP_PATH) ? fs.statSync(YTDLP_PATH).size : 0,
    envProxies: {
      YTDLP_PROXY: process.env.YTDLP_PROXY || null,
      PROXY: process.env.PROXY || null,
      HTTP_PROXY: process.env.HTTP_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null
    },
    versionStdout: '',
    versionStderr: '',
    downloadStdout: '',
    downloadStderr: '',
    code: null,
    signal: null,
    error: null,
    durationMs: 0
  };

  const startTime = Date.now();

  try {
    const p = spawnYtdlp(['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => results.versionStdout += d.toString());
    p.stderr.on('data', d => results.versionStderr += d.toString());
    await new Promise(r => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch(e) {} r(); }, 4000);
      p.on('close', () => { clearTimeout(t); r(); });
      p.on('error', err => { clearTimeout(t); results.versionError = err.message; r(); });
    });
  } catch (e) {
    results.versionError = e.message;
  }

  try {
    const ytdlpArgs = [
      '--force-ipv4',
      '--no-cache-dir',
      '--socket-timeout', '5',
      '--retries', '1',
      '--extractor-args', 'youtube:player_client=android,web',
      '-f', 'ba/b[height<=360]/18/best',
      '--no-playlist',
      '--no-check-certificates',
      '--newline',
      '-v',
      '-o', outTest,
      testUrl
    ];

    const proc = spawnYtdlp(ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => results.downloadStdout += d.toString());
    proc.stderr.on('data', d => results.downloadStderr += d.toString());
    
    const timeout = setTimeout(() => {
      results.timedOut = true;
      try { proc.kill('SIGKILL'); } catch(e) {}
    }, 12000);

    await new Promise(r => {
      proc.on('close', (c, s) => {
        clearTimeout(timeout);
        results.code = c;
        results.signal = s;
        r();
      });
      proc.on('error', err => {
        clearTimeout(timeout);
        results.error = err.message;
        r();
      });
    });
  } catch (e) {
    results.error = e.message;
  }

  results.durationMs = Date.now() - startTime;
  results.fileExists = fs.existsSync(outTest);
  results.fileSize = results.fileExists ? fs.statSync(outTest).size : 0;
  try { if (results.fileExists) fs.unlinkSync(outTest); } catch (e) {}

  res.json(results);
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && timingSafeCompare(password, ADMIN_PASSWORD)) {
    req.session.authenticated = true;
    res.send({ status: "ok", token: ADMIN_PASSWORD });
  } else {
    res.status(401).send({ error: "Invalid password" });
  }
});


const __ytdlp_filename = fileURLToPath(import.meta.url);
const __ytdlp_dirname = path.dirname(__ytdlp_filename);
const isWindows = process.platform === "win32";
const YTDLP_NAME = isWindows ? "yt-dlp.exe" : "yt-dlp";
const YTDLP_PATH = path.join(__ytdlp_dirname, YTDLP_NAME);
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_NAME}`;

// On Pterodactyl containers, /home/container is mounted noexec.
// The yt-dlp file is a Python zipapp (#!/usr/bin/env python3).
// We must run it via python3 explicitly to bypass the noexec restriction.
let PYTHON_CMD = null; // Will be set during startup

function spawnYtdlp(args, options) {
  if (PYTHON_CMD && !isWindows) {
    // Run as: python3 -u /path/to/yt-dlp [args...] (-u forces unbuffered stdout/stderr)
    return spawn(PYTHON_CMD, ['-u', YTDLP_PATH, ...args], options);
  }
  // Fallback: run directly (works on Windows, or if exec is allowed)
  return spawn(YTDLP_PATH, args, options);
}

async function detectPython() {
  for (const cmd of ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3', '/usr/bin/python']) {
    try {
      const p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const result = await new Promise(resolve => {
        let out = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch(e) {} resolve(null); }, 3000);
        p.on('close', code => { clearTimeout(t); resolve(code === 0 ? out.trim() : null); });
        p.on('error', () => { clearTimeout(t); resolve(null); });
      });
      if (result) {
        console.log(`🐍 Found ${cmd}: ${result}`);
        return cmd;
      }
    } catch (e) {}
  }
  return null;
}

async function ensureYtDlp() {
  // Detect Python first (needed on noexec containers)
  if (!isWindows) {
    PYTHON_CMD = await detectPython();
    if (PYTHON_CMD) {
      console.log(`🐍 Will run yt-dlp via: ${PYTHON_CMD} ${YTDLP_PATH}`);
    } else {
      console.log('⚠️ No python3 found, will try direct execution');
    }
  }
  
  if (fs.existsSync(YTDLP_PATH)) {
    const stats = fs.statSync(YTDLP_PATH);
    if (stats.size > 1000) {
      if (!isWindows) {
        try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) {}
      }
      console.log("✅ yt-dlp binary exists and is ready.");
      return true;
    } else {
      console.log("⚠️ yt-dlp binary is corrupted, re-downloading...");
      try { fs.unlinkSync(YTDLP_PATH); } catch (e) {}
    }
  }

  console.log("⬇️ Downloading latest yt-dlp binary from GitHub...");
  
  try {
    const response = await fetch(YTDLP_URL, { redirect: 'follow' });
    
    if (!response.ok) {
      console.error(`❌ yt-dlp download failed: HTTP ${response.status}`);
      return false;
    }
    
    const buffer = await response.buffer();
    fs.writeFileSync(YTDLP_PATH, buffer);
    if (!isWindows) {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) {}
    }
    
    const stats = fs.statSync(YTDLP_PATH);
    console.log(`✅ Latest yt-dlp binary downloaded (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch (err) {
    console.error("❌ yt-dlp download failed:", err.message);
    if (fs.existsSync(YTDLP_PATH)) {
      try { fs.unlinkSync(YTDLP_PATH); } catch (e) {}
    }
    return false;
  }
}

function getCookieArgs() {
  if (!fs.existsSync(path.join(__dirname, 'cookies.txt')) && fs.existsSync(path.join(__dirname, 'cookies.b64'))) {
    try {
      const b64 = fs.readFileSync(path.join(__dirname, 'cookies.b64'), 'utf8');
      fs.writeFileSync(path.join(__dirname, 'cookies.txt'), Buffer.from(b64, 'base64').toString('utf8'), 'utf8');
      console.log('🍪 [CookieEngine] Restored cookies.txt from cookies.b64');
    } catch(e) {}
  }
  const dirs = [__dirname, process.cwd(), '/home/container', path.join('/home/container', 'musicbot-main')];
  const searchNames = [
    'cookies.master.txt', 'cookies.txt', 'cookies .txt', 'www.youtube.com_cookies.txt', 'youtube.com_cookies.txt',
    'youtubecookies.txt', 'youtube_cookies.txt', 'cookie.txt',
    'cookies', 'youtubecookies'
  ];

  let bestFile = null;
  let maxValidSize = 0;

  for (const d of dirs) {
    for (const name of searchNames) {
      const full = path.join(d, name);
      if (name.includes('runtime')) continue;
      if (fs.existsSync(full)) {
        try {
          const stats = fs.statSync(full);
          if (stats.size > 20 && stats.size < 5000000) {
            if (stats.size > maxValidSize) {
              maxValidSize = stats.size;
              bestFile = full;
            }
          }
        } catch (e) {}
      }
    }
  }

  if (bestFile) {
    try {
      // SHIELD MASTER COOKIE FILE:
      // yt-dlp automatically writes back to the cookie file on exit, which strips domain tokens!
      // We copy to an ephemeral runtime file so the master file is NEVER corrupted or overwritten.
      const runtimePath = path.join(CACHE_DIR, 'active_runtime_cookies.txt');
      fs.copyFileSync(bestFile, runtimePath);
      console.log(`🍪 [CookieEngine] Shielded master cookies (${maxValidSize} bytes) from: ${bestFile} -> ${path.basename(runtimePath)}`);
      return ['--cookies', runtimePath];
    } catch (copyErr) {
      console.warn(`⚠️ [CookieEngine] Could not copy to runtime file, using direct file: ${copyErr.message}`);
      return ['--cookies', bestFile];
    }
  }
  return [];
}

function getProxyArgs() {
  const proxy = process.env.YTDLP_PROXY || process.env.PROXY;
  if (proxy && proxy.trim().length > 0) {
    console.log(`🌐 [ProxyEngine] Using proxy for stream requests: ${proxy.trim()}`);
    return ['--proxy', proxy.trim()];
  }
  return [];
}

// Remove any stale local tmp directories that may contain dead PyInstaller locks
try {
  const staleTmp = path.join(__dirname, 'tmp');
  if (fs.existsSync(staleTmp)) fs.rmSync(staleTmp, { recursive: true, force: true });
} catch (e) {}
const ytdlpEnv = {
  ...process.env,
  DENO_V8_FLAGS: '--max-old-space-size=48 --max-semi-space-size=1',
  NODE_OPTIONS: '--max-old-space-size=48'
};

const QUEUE_FILE = path.join(__dirname, "queue_state.json");
const PLAYBACK_STATE_FILE = path.join(__dirname, "playback_state.json");
const ERROR_LOG_FILE = path.join(__dirname, "logs", "errors.log");
const SETTINGS_FILE = path.join(__dirname, "server_settings.json");

const DEFAULT_SETTINGS = {
  announcementsEnabled: false,
  announcementVoice: 'en',
  announcementWordLimit: 10,
  volume: 100,
  audioBitrate: '192k'
};

const VOICE_OPTIONS = {
  'en': 'English (US)',
  'en-gb': 'English (UK)',
  'en-au': 'English (Australia)',
  'en-in': 'English (India)',
  'hi': 'Hindi',
  'ur': 'Urdu',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'ar': 'Arabic'
};

const AVAILABLE_BITRATES = ['96k', '128k', '192k', '256k', '320k'];

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const loaded = JSON.parse(data);
      return { ...DEFAULT_SETTINGS, ...loaded };
    }
  } catch (err) {
    console.error('⚠️ Failed to load settings, using defaults:', err.message);
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings() {
  try {
    const settings = { 
      announcementsEnabled,
      announcementVoice,
      announcementWordLimit,
      volume,
      audioBitrate
    };
    await atomicWrite(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`💾 Settings saved (announcements: ${announcementsEnabled}, voice: ${announcementVoice}, wordLimit: ${announcementWordLimit}, volume: ${volume}%, bitrate: ${audioBitrate})`);
  } catch (err) {
    console.error('⚠️ Failed to save settings:', err.message);
  }
}

const settings = loadSettings();
let announcementsEnabled = settings.announcementsEnabled;
let announcementVoice = settings.announcementVoice || 'en';
let announcementWordLimit = settings.announcementWordLimit || 10;
let volume = settings.volume !== undefined ? settings.volume : 100;
let audioBitrate = settings.audioBitrate || '192k';

function truncateToWords(text, wordLimit) {
  const words = text.split(/\s+/);
  if (words.length <= wordLimit) return text;
  return words.slice(0, wordLimit).join(' ');
}

async function generateTTSAudio(text) {
  try {
    console.log(`🎙️ Generating TTS: "${text.substring(0, 50)}..."`);
    
    const url = await googleTTS(text, announcementVoice, 1);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TTS fetch failed: ${response.status}`);
    }
    
    const audioBuffer = await response.buffer();
    console.log(`✅ TTS audio fetched (${(audioBuffer.length / 1024).toFixed(1)} KB)`);
    
    return audioBuffer;
  } catch (err) {
    console.error('❌ TTS generation failed:', err.message);
    return null;
  }
}

async function injectTTSToStream(ttsBuffer) {
  return new Promise((resolve) => {
    if (!ttsBuffer || !streamManager.pcmInputStream || streamManager.pcmInputStream.destroyed) {
      resolve(false);
      return;
    }
    
    console.log('🎙️ Decoding TTS to PCM and injecting to stream...');
    
    const volumeFilter = volume !== 100 ? `volume=${volume / 100}` : '';
    const filterArgs = volumeFilter ? ['-af', volumeFilter] : [];
    
    const ttsDecoder = spawn(getFFmpegPath(), [
      '-threads', '1',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      ...filterArgs,
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let pcmData = [];
    
    ttsDecoder.stdout.on('data', (chunk) => {
      pcmData.push(chunk);
    });
    
    ttsDecoder.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error')) {
        console.error('TTS decode error:', msg);
      }
    });
    
    ttsDecoder.on('close', async (code) => {
      if (code === 0 && pcmData.length > 0) {
        const fullPCM = Buffer.concat(pcmData);
        const durationSec = (fullPCM.length / 176400).toFixed(1);
        console.log(`✅ TTS decoded (${(fullPCM.length / 1024).toFixed(1)} KB PCM, ~${durationSec}s speech), playing smoothly at 1x rate...`);
        
        try {
          await streamManager.feedPCMAudioRealtime(fullPCM);
          console.log('✅ TTS announcement completed playback');
          resolve(true);
        } catch (err) {
          console.error('Failed to inject TTS:', err.message);
          resolve(false);
        }
      } else {
        console.error('TTS decode failed with code:', code);
        resolve(false);
      }
    });
    
    ttsDecoder.on('error', (err) => {
      console.error('TTS decoder error:', err.message);
      resolve(false);
    });
    
    ttsDecoder.stdin.write(ttsBuffer);
    ttsDecoder.stdin.end();
  });
}

// Pre-allocated static silence buffers to eliminate continuous heap allocations (20/sec)
const SILENCE_50MS_PCM = Buffer.alloc(Math.floor((44100 * 50) / 1000) * 2 * 2, 0);
const SILENCE_300MS_PCM = Buffer.alloc(Math.floor((44100 * 300) / 1000) * 2 * 2, 0);

class PersistentStreamManager {
  constructor() {
    this.clients = new Set();
    this.clientMetadata = new Map();
    this.audioBuffer = [];
    this.maxBufferSize = 200;
    this.instantStartChunks = 80;
    
    this.stats = {
      totalBytes: 0,
      droppedClients: 0,
      peakListeners: 0,
      startTime: Date.now(),
      totalConnections: 0
    };
    
    this.persistentEncoder = null;
    this.pcmInputStream = null;
    this.isEncoderRunning = false;
    this.isSendingSilence = false;
    this.silenceInterval = null;
    
    this.transitionSilenceMs = 150;
    this.transitionPcm = null;
    this.transitionOffset = 0;
    this.loadTransitionTrack();
    
    setInterval(() => {
      const now = Date.now();
      for (const [client, meta] of this.clientMetadata) {
        if (meta.writeFailures > 0) {
          meta.writeFailures = Math.floor(meta.writeFailures * 0.5);
        }
        if (meta.isPaused && (now - meta.pausedAt) > 5000) {
          meta.isPaused = false;
          meta.pausedAt = null;
        }
      }
    }, 10000);
  }
  
  startPersistentEncoder() {
    if (this.isEncoderRunning) {
      console.log('🔧 Persistent encoder already running');
      return;
    }
    
    console.log('🚀 Starting persistent FFmpeg encoder (NEVER STOPS)...');
    
    this.pcmInputStream = new PassThrough({ highWaterMark: 1024 * 1024 });
    
    this.persistentEncoder = spawn(getFFmpegPath(), [
      '-threads', '1',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', audioBitrate,
      '-flush_packets', '1',
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-f', 'mp3',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    this.persistentEncoder.stdout.on('data', (chunk) => {
      this.broadcast(chunk);
    });
    
    this.persistentEncoder.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('FFmpeg encoder:', msg.trim());
      }
    });
    
    this.persistentEncoder.on('error', (err) => {
      console.error('❌ Persistent encoder error:', err.message);
      this.isEncoderRunning = false;
      this.restartEncoder();
    });
    
    this.persistentEncoder.on('close', (code) => {
      console.error(`⚠️ Persistent encoder closed with code ${code} - RESTARTING`);
      this.isEncoderRunning = false;
      this.restartEncoder();
    });
    
    this.pcmInputStream.pipe(this.persistentEncoder.stdin);
    
    this.isEncoderRunning = true;
    this.restartAttempts = 0;
    console.log('✅ Persistent FFmpeg encoder started - will never stop');
    
    this.startSilenceFeed();
  }
  
  restartEncoder() {
    if (this.isEncoderRunning || this.restartTimeout) return;
    
    this.restartAttempts = (this.restartAttempts || 0) + 1;
    const delay = Math.min(1000 * Math.pow(1.5, Math.min(this.restartAttempts - 1, 6)), 15000);
    
    console.log(`🔄 Restarting persistent encoder in ${(delay / 1000).toFixed(1)}s (attempt ${this.restartAttempts})...`);
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.startPersistentEncoder();
    }, delay);
  }
  

  loadTransitionTrack() {
    try {
      const pcmPath = path.join(__dirname, 'assets', 'transition.pcm');
      const m4aPath = path.join(__dirname, 'assets', 'transition.m4a');

      if (!fs.existsSync(pcmPath) && fs.existsSync(m4aPath)) {
        console.log('🔄 [TransitionEngine] Generating transition.pcm from assets/transition.m4a...');
        try {
          execSync(`"${getFFmpegPath()}" -y -i "${m4aPath}" -f s16le -ar 44100 -ac 2 "${pcmPath}"`, { stdio: 'ignore' });
        } catch (convErr) {
          console.warn('⚠️ [TransitionEngine] ffmpeg audio conversion warning:', convErr.message);
        }
      }

      if (fs.existsSync(pcmPath)) {
        const raw = fs.readFileSync(pcmPath);
        const chunkSize = 8820; // 50ms aligned chunk
        const alignedLen = raw.length - (raw.length % chunkSize);
        this.transitionPcm = Buffer.allocUnsafe(alignedLen);
        raw.copy(this.transitionPcm, 0, 0, alignedLen);
        this.transitionOffset = 0;
        console.log(`☕ [TransitionEngine] Loaded seamless transition music loop (${(this.transitionPcm.length / 1024 / 1024).toFixed(2)} MB, ~${(this.transitionPcm.length / 176400).toFixed(1)}s)`);
      } else {
        console.warn('⚠️ [TransitionEngine] No transition track found at assets/transition.m4a');
      }
    } catch (e) {
      console.error('⚠️ [TransitionEngine] Error loading transition track:', e.message);
      this.transitionPcm = null;
    }
  }

  generateSilencePCM(durationMs = 100) {
    if (durationMs === 50) return SILENCE_50MS_PCM;
    if (durationMs === 300) return SILENCE_300MS_PCM;
    const sampleRate = 44100;
    const channels = 2;
    const bytesPerSample = 2;
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const bufferSize = numSamples * channels * bytesPerSample;
    return Buffer.alloc(bufferSize, 0);
  }
  
  startSilenceFeed() {
    if (this.silenceInterval) return;
    
    this.isSendingSilence = true;
    this.silenceStartTime = Date.now();
    this.silenceSentMs = 0;
    console.log(this.transitionPcm ? '☕ Starting transition music loop to keep stream alive...' : '🔇 Starting silence feed to keep encoder alive...');
    
    const CHUNK_MS = 50;
    const CHUNK_SIZE = 8820;
    const silenceZeroChunk = this.generateSilencePCM(CHUNK_MS);
    
    this.silenceInterval = setInterval(() => {
      if (!this.isSendingSilence || !this.pcmInputStream || this.pcmInputStream.destroyed) {
        return;
      }
      
      const elapsedMs = Date.now() - this.silenceStartTime;
      // Clock-corrected pacing: maintain a 250ms lead cushion ahead of wall-clock time
      // Prevents client buffer starvation and eliminates disconnection between tracks
      while (this.silenceSentMs - elapsedMs < 250) {
        let chunk = silenceZeroChunk;
        if (this.transitionPcm && this.transitionPcm.length >= CHUNK_SIZE) {
          chunk = this.transitionPcm.subarray(this.transitionOffset, this.transitionOffset + CHUNK_SIZE);
          this.transitionOffset += CHUNK_SIZE;
          if (this.transitionOffset >= this.transitionPcm.length) {
            this.transitionOffset = 0; // Seamless loop wrap-around
          }
        }
        try {
          this.pcmInputStream.write(chunk);
          this.silenceSentMs += CHUNK_MS;
        } catch (err) {
          break;
        }
      }
    }, 40);
  }
  
  stopSilenceFeed() {
    this.isSendingSilence = false;
    console.log(this.transitionPcm ? '🔊 Stopped transition music - real audio playing' : '🔊 Stopped silence feed - real audio playing');
  }
  
  resumeSilenceFeed() {
    this.isSendingSilence = true;
    this.silenceStartTime = Date.now();
    this.silenceSentMs = 0;
    console.log(this.transitionPcm ? '☕ Resuming transition music loop...' : '🔇 Resuming silence feed...');
  }
  
  injectTransitionSilence() {
    if (!this.pcmInputStream || this.pcmInputStream.destroyed) return;
    
    console.log(`🔇 Injecting ${this.transitionSilenceMs}ms transition silence...`);
    const silenceBuffer = this.generateSilencePCM(this.transitionSilenceMs);
    
    try {
      this.pcmInputStream.write(silenceBuffer);
    } catch (err) {
      console.error('Failed to inject transition silence:', err.message);
    }
  }
  
  feedPCMAudio(pcmChunk) {
    if (!this.pcmInputStream || this.pcmInputStream.destroyed) {
      console.error('⚠️ PCM input stream not available');
      return false;
    }
    
    if (this.isSendingSilence) {
      this.stopSilenceFeed();
    }
    
    try {
      return this.pcmInputStream.write(pcmChunk);
    } catch (err) {
      console.error('Error feeding PCM audio:', err.message);
      return false;
    }
  }

  async feedPCMAudioRealtime(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0) return true;
    if (!this.pcmInputStream || this.pcmInputStream.destroyed) {
      console.error('⚠️ PCM input stream not available');
      return false;
    }

    if (this.isSendingSilence) {
      this.stopSilenceFeed();
    }

    const TARGET_LEAD_MS = 250;
    const chunkSize = 8820; // 50ms of 44.1kHz 16-bit stereo PCM
    let offset = 0;
    const startTime = Date.now();

    while (offset < pcmBuffer.length) {
      if (!this.pcmInputStream || this.pcmInputStream.destroyed) break;
      const end = Math.min(offset + chunkSize, pcmBuffer.length);
      const chunk = pcmBuffer.slice(offset, end);
      try {
        this.pcmInputStream.write(chunk);
      } catch (err) {
        console.error('Error writing realtime PCM chunk:', err.message);
        break;
      }
      offset = end;

      // Maintain an exact 250ms lead cushion ahead of wall-clock real time
      const audioDurationSentMs = (offset / 176400) * 1000;
      const realTimeElapsedMs = Date.now() - startTime;
      const leadMs = audioDurationSentMs - realTimeElapsedMs;

      if (leadMs > TARGET_LEAD_MS) {
        const sleepMs = leadMs - TARGET_LEAD_MS;
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }

    // Await the remaining lead audio so the announcement finishes naturally in real-time
    const totalDurationMs = (pcmBuffer.length / 176400) * 1000;
    const remainingMs = Math.max(0, totalDurationMs - (Date.now() - startTime));
    if (remainingMs > 0) {
      await new Promise(r => setTimeout(r, remainingMs));
    }

    return true;
  }
  
  generateSilenceChunk() {
    const frames = [];
    for (let i = 0; i < 10; i++) {
      const frameHeader = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
      const frameData = Buffer.alloc(413, 0);
      frames.push(Buffer.concat([frameHeader, frameData]));
    }
    return Buffer.concat(frames);
  }
  
  addClient(res, req) {
    const now = Date.now();
    
    const clientInfo = {
      addedAt: now,
      bytesWritten: 0,
      writeFailures: 0,
      lastWrite: now,
      lastSuccessfulWrite: now,
      isPaused: false,
      pausedAt: null,
      clientId: `${now}-${Math.random().toString(36).substr(2, 9)}`
    };
    
    this.clients.add(res);
    this.clientMetadata.set(res, clientInfo);
    this.stats.totalConnections++;
    
    if (this.clients.size > this.stats.peakListeners) {
      this.stats.peakListeners = this.clients.size;
    }
    
    if (this.audioBuffer.length > 0) {
      try {
        const startIdx = Math.max(0, this.audioBuffer.length - this.instantStartChunks);
        const burstChunks = this.audioBuffer.slice(startIdx);
        if (burstChunks.length > 0) {
          const burstData = Buffer.concat(burstChunks);
          res.write(burstData);
          clientInfo.bytesWritten += burstData.length;
        }
      } catch (err) {
      }
    }
    
    let cleanupCalled = false;
    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      setTimeout(() => {
        this.removeClient(res);
      }, 100);
    };
    
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('error', cleanup);
    res.on('close', cleanup);
    
    res.on('drain', () => {
      const meta = this.clientMetadata.get(res);
      if (meta) {
        meta.isPaused = false;
        meta.pausedAt = null;
        meta.lastSuccessfulWrite = Date.now();
      }
    });
    
    console.log(`📻 Client connected (${this.clients.size} total, ID: ${clientInfo.clientId})`);
  }
  
  removeClient(res) {
    if (this.clients.has(res)) {
      const meta = this.clientMetadata.get(res);
      const clientId = meta?.clientId || 'unknown';
      
      this.clients.delete(res);
      this.clientMetadata.delete(res);
      
      console.log(`📻 Client disconnected (${this.clients.size} remaining, ID: ${clientId})`);
    }
  }
  
  broadcast(chunk) {
    this.audioBuffer.push(chunk);
    if (this.audioBuffer.length > this.maxBufferSize) {
      this.audioBuffer.shift();
    }
    
    if (this.clients.size === 0) return;
    
    this.stats.totalBytes += chunk.length;
    const clientsToRemove = [];
    const now = Date.now();
    
    for (const client of this.clients) {
      const meta = this.clientMetadata.get(client);
      if (!meta) continue;
      
      // Zombie client check: 45 seconds of no activity
      const timeSinceLastSuccess = now - meta.lastSuccessfulWrite;
      if (timeSinceLastSuccess > 45000) {
        console.log(`⚠️ Dropping unresponsive client after ${Math.floor(timeSinceLastSuccess/1000)}s`);
        clientsToRemove.push(client);
        this.stats.droppedClients++;
        continue;
      }

      // If client socket has accumulated over 512KB (~32 seconds) of unsent data, drop frozen connection
      if (client.writableLength > 1024 * 1024) {
        console.log(`⚠️ Dropping frozen client (${Math.floor(client.writableLength / 1024)} KB queued)`);
        clientsToRemove.push(client);
        this.stats.droppedClients++;
        continue;
      }
      
      try {
        const canWrite = client.write(chunk);
        meta.lastWrite = now;
        if (canWrite) {
          meta.lastSuccessfulWrite = now;
        }
        meta.bytesWritten += chunk.length;
      } catch (err) {
        if (err.code === 'ERR_STREAM_DESTROYED' || err.code === 'EPIPE' || err.code === 'ECONNRESET') {
          clientsToRemove.push(client);
        }
      }
    }
    
    for (const client of clientsToRemove) {
      this.removeClient(client);
      try {
        client.end();
      } catch (e) {}
    }
  }
  
  getStats() {
    const uptime = (Date.now() - this.stats.startTime) / 1000;
    const bytesPerSecond = uptime > 0 ? this.stats.totalBytes / uptime : 0;
    
    let pausedClients = 0;
    for (const [, meta] of this.clientMetadata) {
      if (meta.isPaused) pausedClients++;
    }
    
    return {
      activeListeners: this.clients.size,
      pausedListeners: pausedClients,
      peakListeners: this.stats.peakListeners,
      totalConnections: this.stats.totalConnections,
      totalBytesSent: this.stats.totalBytes,
      droppedClients: this.stats.droppedClients,
      bytesPerSecond: Math.round(bytesPerSecond),
      uptimeSeconds: Math.round(uptime),
      bufferSize: this.audioBuffer.length,
      isSendingSilence: this.isSendingSilence,
      encoderRunning: this.isEncoderRunning
    };
  }
  
  getHealthStatus() {
    return {
      encoderPID: this.persistentEncoder?.pid || null,
      encoderAlive: this.persistentEncoder && !this.persistentEncoder.killed,
      isEncoderRunning: this.isEncoderRunning,
      clientCount: this.clients.size,
      isSendingSilence: this.isSendingSilence
    };
  }
  
  clear() {
    this.clients.clear();
    this.clientMetadata.clear();
  }
  
  clearAudioBuffer() {
    const oldLength = this.audioBuffer.length;
    this.audioBuffer = [];
    console.log(`🧹 Audio buffer cleared (had ${oldLength} chunks)`);
  }
}

function logError(functionName, error, additionalContext = {}) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const errorType = error.name || 'Error';
  const errorMessage = error.message || String(error);
  const stack = error.stack || 'No stack trace available';
  
  let logEntry = `[${timestamp}] ============================================================\n`;
  logEntry += `Function: ${functionName}\n`;
  logEntry += `Error Type: ${errorType}\n`;
  logEntry += `Error Message: ${errorMessage}\n`;
  
  if (Object.keys(additionalContext).length > 0) {
    logEntry += `Additional Context: ${JSON.stringify(additionalContext, null, 2)}\n`;
  }
  
  logEntry += `------------------------------------------------------------\n`;
  logEntry += `Stack Trace:\n${stack}\n`;
  logEntry += `============================================================\n\n`;
  
  try {
    const logsDir = path.dirname(ERROR_LOG_FILE);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.appendFileSync(ERROR_LOG_FILE, logEntry, 'utf8');
    console.error(`❌ Error logged to ${ERROR_LOG_FILE}: ${errorMessage}`);
  } catch (writeError) {
    console.error('Failed to write to error log:', writeError.message);
    console.error('Original error:', errorMessage);
  }
}

const writeLocks = {};

async function atomicWrite(filepath, data) {
  while (writeLocks[filepath]) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeLocks[filepath] = true;
  try {
    const tempPath = filepath + '.tmp';
    await fs.promises.writeFile(tempPath, data);
    await fs.promises.rename(tempPath, filepath);
  } finally {
    writeLocks[filepath] = false;
  }
}

let queue = [];
let isPlaying = false;
let currentTitle = "No music playing";
let currentMetadata = null;
let currentIsAutoplay = false;
let currentYtdlp = null;
let currentDecoder = null;
let isTransitioning = false;
let isPreparingTrack = false;
let streamVersion = 0;
let currentStreamId = 0;
let lastSkipTime = 0;
let currentStartTime = 0;
let consecutiveZeroByteFailures = 0;

const CACHE_DIR = path.join(__dirname, 'cache');
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } else {
    const staleFiles = fs.readdirSync(CACHE_DIR);
    for (const f of staleFiles) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) {}
    }
  }
} catch (e) {}
let currentLocalFilePath = null;

// 🧹 Auto-prune cache directory to prevent Linux page-cache and disk bloat (cgroup OOM prevention)
function pruneStaleCacheFiles(keepFile = null) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const keepBasename = keepFile ? path.basename(keepFile) : null;
    let prunedCount = 0;
    for (const f of files) {
      if (f.endsWith('.m4a') || f.endsWith('.part') || f.endsWith('.ytdl')) {
        if (f !== keepBasename && !f.includes('transition')) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, f));
            prunedCount++;
          } catch (e) {}
        }
      }
    }
    if (prunedCount > 0) {
      console.log(`🧹 [MemoryGuard] Pruned ${prunedCount} stale audio cache files from disk`);
    }
  } catch (e) {}
}


const streamManager = new PersistentStreamManager();

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = fs.readFileSync(QUEUE_FILE, 'utf8');
      const savedQueue = JSON.parse(data);
      
      if (!Array.isArray(savedQueue)) {
        console.error('⚠️ Queue file corrupted: not an array, resetting to empty queue');
        return [];
      }
      
      console.log(`📂 Loaded ${savedQueue.length} songs from saved queue`);
      return savedQueue;
    }
  } catch (err) {
    console.error('⚠️ Failed to load queue:', err.message);
    logError('loadQueue', err, { queueFile: QUEUE_FILE });
  }
  return [];
}

async function saveQueue() {
  try {
    await atomicWrite(QUEUE_FILE, JSON.stringify(queue, null, 2));
    console.log(`💾 Queue saved (${queue.length} songs)`);
    broadcastEvent();
  } catch (err) {
    console.error('⚠️ Failed to save queue:', err.message);
    logError('saveQueue', err, { queueLength: queue.length });
  }
}

function loadPlaybackState() {
  try {
    if (fs.existsSync(PLAYBACK_STATE_FILE)) {
      const data = fs.readFileSync(PLAYBACK_STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      console.log(`📂 Loaded playback state (was playing: ${state.isPlaying})`);
      return state;
    }
  } catch (err) {
    console.error('⚠️ Failed to load playback state:', err.message);
  }
  return { isPlaying: false, currentTitle: null, currentMetadata: null };
}

async function savePlaybackState() {
  try {
    const state = {
      isPlaying,
      currentTitle,
      currentMetadata,
      currentIsAutoplay,
      savedAt: Date.now()
    };
    await atomicWrite(PLAYBACK_STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 Playback state saved (playing: ${currentTitle})`);
    broadcastEvent();
  } catch (err) {
    console.error('⚠️ Failed to save playback state:', err.message);
  }
}

const metadataCache = new Map();
const CACHE_TTL = 1800000; // 30 minutes

function getCached(key) {
  const cached = metadataCache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }
  return null;
}

function setCache(key, data) {
  metadataCache.set(key, { data, timestamp: Date.now() });
  if (metadataCache.size > 150) {
    const keys = Array.from(metadataCache.keys());
    for (let i = 0; i < 50; i++) metadataCache.delete(keys[i]);
  }
}

async function searchYouTube(query) {
  const cacheKey = `search:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const results = await yts(query);
    if (results.videos && results.videos.length > 0) {
      const video = results.videos[0];
      const result = {
        url: video.url,
        title: video.title,
        artist: video.author?.name || video.author || "Unknown Artist",
        duration: video.timestamp || "Unknown",
        durationSeconds: video.seconds || 0,
        views: video.views ? video.views.toLocaleString() : "0",
        thumbnail: video.thumbnail || video.image || "",
        ago: video.ago || "",
        videoId: video.videoId
      };
      setCache(cacheKey, result);
      return result;
    }
    return null;
  } catch (err) {
    console.error("YouTube search error:", err);
    logError('searchYouTube', err, { query });
    return null;
  }
}

async function getVideoMetadata(url) {
  const cacheKey = `meta:${url}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    let videoId = null;
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('youtu.be')) {
      videoId = urlObj.pathname.substring(1);
    } else {
      videoId = urlObj.searchParams.get('v');
    }
    
    if (videoId) {
      const results = await yts({ videoId: videoId });
      if (results && results.title) {
        const metaResult = {
          url: url,
          title: results.title,
          artist: results.author?.name || results.author || "Unknown Artist",
          duration: results.timestamp || "Unknown",
          durationSeconds: results.seconds || 0,
          views: results.views ? results.views.toLocaleString() : "0",
          thumbnail: results.thumbnail || results.image || "",
          ago: results.ago || "",
          videoId: videoId
        };
        setCache(cacheKey, metaResult);
        return metaResult;
      }
    }
    return null;
  } catch (err) {
    console.error("Metadata fetch error:", err);
    return null;
  }
}

function killCurrentStream() {
  // Free memory immediately after stream termination
  if (typeof global.gc === 'function') { try { global.gc(); } catch (e) {} }
  currentStreamId++;
  if (currentYtdlp && currentDecoder) {
    try {
      currentYtdlp.stdout.unpipe();
    } catch (e) {}
  }
  
  if (currentDecoder) {
    try {
      if (currentDecoder.stdin && !currentDecoder.stdin.destroyed) {
        currentDecoder.stdin.destroy();
      }
      if (currentDecoder.stdout && !currentDecoder.stdout.destroyed) {
        currentDecoder.stdout.destroy();
      }
      if (currentDecoder.stderr && !currentDecoder.stderr.destroyed) {
        currentDecoder.stderr.destroy();
      }
    } catch (e) {}
    try {
      currentDecoder.kill('SIGKILL');
    } catch (e) {}
    currentDecoder = null;
  }
  
  if (currentYtdlp) {
    try {
      if (currentYtdlp.stdout && !currentYtdlp.stdout.destroyed) {
        currentYtdlp.stdout.destroy();
      }
      if (currentYtdlp.stderr && !currentYtdlp.stderr.destroyed) {
        currentYtdlp.stderr.destroy();
      }
    } catch (e) {}
    try {
      currentYtdlp.kill('SIGKILL');
    } catch (e) {}
    currentYtdlp = null;
  }

  if (currentLocalFilePath) {
    try {
      if (fs.existsSync(currentLocalFilePath)) {
        fs.unlinkSync(currentLocalFilePath);
      }
    } catch (e) {}
    currentLocalFilePath = null;
  }
  
  // streamManager.clearAudioBuffer(); // Keep circular audio buffer intact to prevent client stream starvation
}

function executeYtdlpDownload(url, outputPath, thisStreamId, withCookies = true) {
  const cookieArgs = withCookies ? getCookieArgs() : [];
  const proxyArgs = getProxyArgs();
  const isSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');
  // Prefer lightweight Node.js engine (30MB) over heavyweight Deno (250MB) to prevent Render 512MB OOM
  const jsRuntimeArgs = ['--no-js-runtimes', '--js-runtimes', 'node'];
  const potArgs = isSoundCloud ? [] : [
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
    '--extractor-args', 'youtube:player_client=visionos,android',
  ];
  const formatArg = 'bestaudio/ba/b/best';

  const ytdlpArgs = [
    '--force-ipv4',
    '--no-cache-dir',
    '--socket-timeout', '8',
    '--retries', '3',
    '--concurrent-fragments', '5',
    ...jsRuntimeArgs,
    ...potArgs,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    '-f', formatArg,
    '--no-playlist',
    '--no-check-certificates',
    '--newline',
    ...proxyArgs,
    ...cookieArgs,
    '-o', outputPath,
    url
  ];

  console.log(`📥 [Downloader] Fetching audio track to "${path.basename(outputPath)}"${withCookies ? ' (with cookies)' : ' (direct fast mode)'} from ${isSoundCloud ? 'SoundCloud' : 'YouTube'}...`);

  return new Promise((resolve, reject) => {
    if (thisStreamId !== currentStreamId) return reject(new Error('Superseded'));

    currentYtdlp = spawnYtdlp(ytdlpArgs, { env: ytdlpEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastLog = 0;
    let errOutput = '';
    let isSettled = false;

    // Hard timeout: 45s max for yt-dlp download
    const downloadTimeout = setTimeout(() => {
      if (!isSettled && currentYtdlp) {
        console.error(`⚠️ [Downloader] yt-dlp download timed out after 45s. Aborting download.`);
        try { currentYtdlp.kill('SIGKILL'); } catch (e) {}
      }
    }, 45000);

    const handleOutput = (d, isErr) => {
      const msg = d.toString();
      if (isErr) errOutput += msg;
      const lines = msg.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes('[download]') && trimmed.includes('%')) {
          const now = Date.now();
          if (now - lastLog > 1500 || trimmed.includes('100%')) {
            lastLog = now;
            console.log(`📥 [yt-dlp] ${trimmed}`);
          }
        } else if (trimmed.includes('ERROR') || trimmed.includes('error')) {
          console.error(`❌ [yt-dlp Error] ${trimmed}`);
        } else if (trimmed.includes('WARNING') || trimmed.includes('warning')) {
          console.warn(`⚠️ [yt-dlp] ${trimmed}`);
        } else if (trimmed.startsWith('[')) {
          console.log(`ℹ️ [yt-dlp] ${trimmed}`);
        }
      }
    };

    if (currentYtdlp.stdout) {
      currentYtdlp.stdout.on('data', (d) => handleOutput(d, false));
    }
    if (currentYtdlp.stderr) {
      currentYtdlp.stderr.on('data', (d) => handleOutput(d, true));
    }

    currentYtdlp.on('close', (code, signal) => {
      clearTimeout(downloadTimeout);
      currentYtdlp = null;
      if (isSettled) return;
      isSettled = true;

      if (thisStreamId !== currentStreamId) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        return reject(new Error('Superseded'));
      }

      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
        const mb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
        console.log(`✅ [Downloader] Track file ready (${mb} MB) at "${path.basename(outputPath)}"`);
        resolve(outputPath);
      } else {
        const err = `yt-dlp exited with code ${code} (signal: ${signal}): ${errOutput.slice(-300).trim()}`;
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        reject(new Error(err));
      }
    });

    currentYtdlp.on('error', (err) => {
      clearTimeout(downloadTimeout);
      currentYtdlp = null;
      if (isSettled) return;
      isSettled = true;
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
      reject(err);
    });
  });
}

async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');

  // 1. Primary: Direct YouTube with visionos/android client & PO token (avoids web SABR/ad format blocks)
  if (!isDirectSoundCloud) {
    try {
      console.log(`🎬 [Downloader] Fetching studio audio directly from YouTube (visionos/android)...`);
      return await executeYtdlpDownload(url, outputPath, thisStreamId, false);
    } catch (ytErr) {
      if (thisStreamId !== currentStreamId) throw ytErr;
      console.warn(`⚠️ [Downloader] Direct YouTube failed: ${ytErr.message.slice(0, 120)}`);
      const cookieArgs = getCookieArgs();
      if (cookieArgs.length > 0) {
        try {
          console.log(`🔄 [Downloader] Retrying YouTube with authenticated cookies...`);
          return await executeYtdlpDownload(url, outputPath, thisStreamId, true);
        } catch (retryErr) {
          if (thisStreamId !== currentStreamId) throw retryErr;
          console.warn(`⚠️ [Downloader] Cookie YouTube failed: ${retryErr.message.slice(0, 120)}`);
        }
      }
    }
  }

  // 2. Only if YouTube is completely unreachable and title exists, use clean verified SoundCloud fallback
  if (title) {
    const cleanQuery = title
      .replace(/^(?:video\s*song|full\s*video|official\s*video|audio\s*song)\s*[-:]\s*/i, '')
      .replace(/[#|/]/g, ' ')
      .replace(/\b(official|music|video|song|full|lyrics|hd|4k)\b/gi, '')
      .trim();
    const scQuery = `scsearch1:${cleanQuery} original -cover -nightcore -slowed -reverb -karaoke`;
    console.log(`⚡ [Downloader] SoundCloud Fallback: Fetching original audio for "${cleanQuery}"...`);
    try {
      return await executeYtdlpDownload(scQuery, outputPath, thisStreamId, false);
    } catch (scErr) {
      console.warn(`⚠️ [Downloader] Filtered SoundCloud failed, retrying standard query...`);
      return await executeYtdlpDownload(`scsearch1:${cleanQuery}`, outputPath, thisStreamId, false);
    }
  }
}

async function startStream(url, title, metadata) {
  killCurrentStream();
  const thisStreamId = ++currentStreamId;
  isPreparingTrack = true;
  isTransitioning = true;
  isPlaying = false;
  currentStartTime = 0;
  currentTitle = title || "Preparing track...";
  currentMetadata = metadata;
  broadcastEvent();
  
  console.log(`\n🎵 Starting stream #${thisStreamId}: ${title || url}`);
  
  streamManager.resumeSilenceFeed();

  const localFilePath = path.join(CACHE_DIR, `track_${thisStreamId}.m4a`);
  currentLocalFilePath = localFilePath;
  pruneStaleCacheFiles(localFilePath);

  // 1. Start downloading complete track file in background IMMEDIATELY
  const downloadPromise = downloadTrackToFile(url, localFilePath, thisStreamId, title).catch(err => {
    console.error(`❌ Track download failed: ${err.message}`);
    return null;
  });

  // 2. Play TTS announcement in parallel if enabled
  const hasAnnouncement = announcementsEnabled && (title || (metadata && metadata.title));
  if (hasAnnouncement) {
    let songTitle = title || metadata?.title || 'Unknown Track';
    songTitle = truncateToWords(songTitle, announcementWordLimit);
    
    const artistName = metadata?.artist || 'Unknown Artist';
    const requester = metadata?.requesterUsername;
    const dedicatedTo = metadata?.dedicatedTo;
    const dedicatedBy = metadata?.dedicatedBy;
    
    let announcementText = '';
    if (dedicatedTo && dedicatedBy) {
      announcementText = `Dedicated to ${dedicatedTo} by ${dedicatedBy}. Now playing: ${songTitle}, by ${artistName}`;
    } else if (requester) {
      announcementText = `Requested by ${requester}. Now playing: ${songTitle}, by ${artistName}`;
    } else {
      announcementText = `Now playing: ${songTitle}, by ${artistName}`;
    }
    
    console.log(`🎙️ Announcement: ${announcementText}`);
    
    try {
      const ttsBuffer = await generateTTSAudio(announcementText);
      if (ttsBuffer && thisStreamId === currentStreamId) {
        streamManager.injectTransitionSilence();
        await injectTTSToStream(ttsBuffer);
        streamManager.injectTransitionSilence();
      }
    } catch (ttsErr) {
      console.error('⚠️ TTS announcement error:', ttsErr.message);
    }
  }

  // If track was superseded or skipped during TTS, abort
  if (thisStreamId !== currentStreamId) {
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    return;
  }

  // Keep silence feed running while awaiting track preparation so listeners never experience dead air
  streamManager.resumeSilenceFeed();

  // 3. Await the complete downloaded track file (usually already ready!)
  const readyFile = await downloadPromise;

  if (thisStreamId !== currentStreamId) {
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    return;
  }

  if (!readyFile) {
    if (thisStreamId !== currentStreamId) return;
    consecutiveZeroByteFailures++;
    console.warn(`⚠️ Track preparation failed for "${title}". Failures: ${consecutiveZeroByteFailures}/3`);
    isPreparingTrack = false;
    isTransitioning = false;
    if (consecutiveZeroByteFailures >= 3) {
      console.error(`🛑 [Stream Loop Guard] 3 consecutive failures. Halting playback.`);
      softStopPlayback();
    } else {
      setTimeout(() => {
        if (thisStreamId === currentStreamId) playNext();
      }, 3000);
    }
    return;
  }

  // 4. Stream the complete local file natively with Frame-Aligned Pacer
  const volumeFilter = volume !== 100 ? `volume=${volume / 100}` : '';
  const filterArgs = volumeFilter ? ['-af', volumeFilter] : [];

  console.log(`🔊 [Local Streamer] Decoding "${path.basename(localFilePath)}" and starting smooth playback...`);

  // Decode local file at max speed into memory buffer queue
  const ffmpegArgs = [
    '-threads', '1',
    '-vn', '-sn', '-dn',
    '-i', localFilePath,
    '-f', 's16le',
    '-ar', '44100',
    '-ac', '2',
    ...filterArgs,
    'pipe:1'
  ];

  currentDecoder = spawn(getFFmpegPath(), ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  const CHUNK_SIZE = 8820; // Exactly 50ms of 44.1kHz 16-bit stereo PCM (2,205 samples)
  let pcmBuffer = Buffer.alloc(0);
  let isDecoderPaused = false;
  let decoderFinished = false;
  let totalBytesDecoded = 0;

  // Maximum PCM buffer: 10 seconds (~1.76 MB), resume at 3 seconds (~528 KB)
  const MAX_ACCUM_BYTES = CHUNK_SIZE * 200;
  const RESUME_ACCUM_BYTES = CHUNK_SIZE * 60;

  let lastPcmReceivedAt = Date.now();

  currentDecoder.stdout.on('data', (chunk) => {
    lastPcmReceivedAt = Date.now();
    pcmBuffer = pcmBuffer.length === 0 ? chunk : Buffer.concat([pcmBuffer, chunk]);
    totalBytesDecoded += chunk.length;

    if (!isDecoderPaused && pcmBuffer.length >= MAX_ACCUM_BYTES) {
      currentDecoder.stdout.pause();
      isDecoderPaused = true;
    }
  });

  currentDecoder.stdout.on('end', () => {
    decoderFinished = true;
  });

  currentDecoder.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg.includes('Error') || msg.includes('fatal') || msg.includes('Conversion failed')) {
      console.warn(`⚠️ [FFmpeg Decoder] ${msg.split(/\r?\n/).slice(-1)[0]}`);
    }
  });

  currentDecoder.on('close', (code) => {
    decoderFinished = true;
  });

  currentDecoder.on('error', (err) => {
    console.error('FFmpeg decoder process error:', err.message);
    decoderFinished = true;
  });

  // Wait for initial pre-buffer (0.5s cushion = 88,200 bytes)
  while (pcmBuffer.length < 88200 && !decoderFinished) {
    if (thisStreamId !== currentStreamId) return;
    await new Promise(r => setTimeout(r, 20));
  }

  if (thisStreamId !== currentStreamId) return;

  if (pcmBuffer.length === 0 && decoderFinished) {
    if (thisStreamId !== currentStreamId) return;
    consecutiveZeroByteFailures++;
    console.warn(`⚠️ Track decoding produced 0 bytes for "${title}". Failures: ${consecutiveZeroByteFailures}/3`);
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    currentLocalFilePath = null;
    isPreparingTrack = false;
    isTransitioning = false;
    if (consecutiveZeroByteFailures >= 3) {
      softStopPlayback();
    } else {
      setTimeout(() => {
        if (thisStreamId === currentStreamId) playNext();
      }, 3000);
    }
    return;
  }

  if (thisStreamId !== currentStreamId) return;

  // Ready to play!
  streamManager.stopSilenceFeed();
  isPlaying = true;
  isPreparingTrack = false;
  isTransitioning = false;
  currentTitle = title || "Unknown Track";
  currentMetadata = metadata;
  currentStartTime = Date.now();
  streamVersion++;
  console.log("🎧 Now playing:", currentTitle);
  savePlaybackState();
  broadcastEvent();

  const TARGET_LEAD_MS = 250;
  const pacingStartTime = Date.now();
  let bytesSent = 0;

  const expectedDurationSec = (metadata && metadata.durationSeconds) 
    ? Number(metadata.durationSeconds) 
    : (currentMetadata && currentMetadata.durationSeconds ? Number(currentMetadata.durationSeconds) : 0);
  const maxAllowedDurationMs = expectedDurationSec > 0 ? (expectedDurationSec + 8) * 1000 : 0;

  console.log(`🔊 [Playing] Continuous 1.0x frame-accurate playback active!`);

  // Stream in steady, frame-aligned 50ms chunks using self-correcting lead cushion
  while (thisStreamId === currentStreamId) {
    // 1. If decoder has finished, drain remaining audio and EXIT cleanly
    if (decoderFinished) {
      if (pcmBuffer.length >= CHUNK_SIZE) {
        const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
        pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
        streamManager.feedPCMAudio(chunk);
        bytesSent += CHUNK_SIZE;
      } else {
        // Flush remaining audio aligned to 4 bytes (16-bit stereo frame = 4 bytes)
        if (pcmBuffer.length >= 4) {
          const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
          const chunk = pcmBuffer.subarray(0, validLen);
          streamManager.feedPCMAudio(chunk);
          bytesSent += validLen;
        }
        pcmBuffer = Buffer.alloc(0);
        break; // All audio completely finished!
      }
    } else if (pcmBuffer.length >= CHUNK_SIZE) {
      const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
      pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
      streamManager.feedPCMAudio(chunk);
      bytesSent += CHUNK_SIZE;

      if (isDecoderPaused && pcmBuffer.length <= RESUME_ACCUM_BYTES) {
        if (currentDecoder && currentDecoder.stdout && !currentDecoder.stdout.destroyed) {
          currentDecoder.stdout.resume();
          isDecoderPaused = false;
        }
      }

      // Maintain an exact 250ms lead cushion ahead of wall-clock real time
      const audioDurationSentMs = (bytesSent / 176400) * 1000;
      const realTimeElapsedMs = Date.now() - pacingStartTime;
      const leadMs = audioDurationSentMs - realTimeElapsedMs;

      if (leadMs > TARGET_LEAD_MS) {
        const sleepMs = leadMs - TARGET_LEAD_MS;
        await new Promise(r => setTimeout(r, sleepMs));
      }
    } else {
      // 2. Decoder stall watchdog: if no new data arrived for 8s and buffer is low
      if (Date.now() - lastPcmReceivedAt > 8000) {
        console.warn(`⚠️ [Decoder Watchdog] Decoder stalled with no new audio for 8s. Finishing track.`);
        if (pcmBuffer.length >= 4) {
          const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
          streamManager.feedPCMAudio(pcmBuffer.subarray(0, validLen));
          bytesSent += validLen;
        }
        pcmBuffer = Buffer.alloc(0);
        decoderFinished = true;
        break;
      }

      // Waiting for decoder to fill next 50ms chunk
      await new Promise(r => setTimeout(r, 10));
    }

    // 3. Duration limit watchdog: if playback exceeded expected duration + grace period
    const realTimeElapsedMs = Date.now() - pacingStartTime;
    if (maxAllowedDurationMs > 0 && realTimeElapsedMs > maxAllowedDurationMs) {
      console.warn(`⏰ [Duration Watchdog] Song reached duration limit (${expectedDurationSec}s + grace). Finishing track gracefully.`);
      break;
    }
  }

  // Ensure decoder process is terminated immediately after loop
  if (currentDecoder) {
    try {
      if (currentDecoder.stdout && !currentDecoder.stdout.destroyed) currentDecoder.stdout.destroy();
      if (!currentDecoder.killed) currentDecoder.kill('SIGKILL');
    } catch (e) {}
    currentDecoder = null;
  }

  // If track was skipped or superseded, abort cleanly
  if (thisStreamId !== currentStreamId) {
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    return;
  }

  // All bytes fed to persistent encoder. Await remaining lead cushion so listeners hear final notes.
  const totalTrackDurationMs = (bytesSent / 176400) * 1000;
  const remainingPlayTimeMs = Math.max(0, Math.min(2000, totalTrackDurationMs - (Date.now() - pacingStartTime)));
  if (remainingPlayTimeMs > 0) {
    await new Promise(r => setTimeout(r, remainingPlayTimeMs));
  }

  if (thisStreamId !== currentStreamId) return;

  const totalPlayedSec = Math.floor((Date.now() - currentStartTime) / 1000);
  console.log(`✅ Track completed: ${title || currentTitle} (${totalPlayedSec}s, ${(bytesSent / 1024).toFixed(1)} KB)`);

  streamManager.resumeSilenceFeed();

  // Clean up local track file immediately
  try {
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
  } catch (e) {}
  currentLocalFilePath = null;

  consecutiveZeroByteFailures = 0;
  isPlaying = false;
  isPreparingTrack = false;
  isTransitioning = false;
  currentStartTime = 0;
  savePlaybackState();
  broadcastEvent();

  if (thisStreamId === currentStreamId) {
    playNext();
  }
}

function softStopPlayback() {
  console.log("⏸️ Soft stop - keeping stream alive with silence...");
  currentStreamId++;
  isPlaying = false;
  isPreparingTrack = false;
  isTransitioning = false;
  
  savePlaybackState();
  
  killCurrentStream();
  
  currentTitle = "Waiting for next song...";
  currentMetadata = null;
  currentIsAutoplay = false;
  
  streamManager.resumeSilenceFeed();
}

function stopPlayback() {
  console.log("⏸️ Stopping playback completely...");
  currentStreamId++;
  isPlaying = false;
  isPreparingTrack = false;
  isTransitioning = false;
  
  savePlaybackState();
  
  killCurrentStream();
  
  currentTitle = "No music playing";
  currentMetadata = null;
  currentIsAutoplay = false;

  streamManager.resumeSilenceFeed();
}

const sseClients = new Set();
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  
  sseClients.add(res);
  
  const currentState = {
    isPlaying,
    isTransitioning,
    currentTitle,
    currentMetadata,
    queue,
    startTime: currentStartTime,
    serverElapsed: isPlaying && currentStartTime > 0 ? Math.max(0, Date.now() - currentStartTime) : 0,
    volume,
    announcementsEnabled,
    health: streamManager.getHealthStatus(),
    stats: streamManager.getStats()
  };
  res.write(`data: ${JSON.stringify(currentState)}\n\n`);
  
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 20000);
  
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function broadcastEvent() {
  if (sseClients.size === 0) return;
  const currentState = {
    isPlaying,
    isTransitioning,
    currentTitle,
    currentMetadata,
    queue,
    startTime: currentStartTime,
    serverElapsed: isPlaying && currentStartTime > 0 ? Math.max(0, Date.now() - currentStartTime) : 0,
    volume,
    announcementsEnabled,
    health: streamManager.getHealthStatus(),
    stats: streamManager.getStats()
  };
  const payload = `data: ${JSON.stringify(currentState)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function broadcastEventJSON(data) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// REST API for web interface
function isValidYouTubeURL(urlString) {
  try {
    if (typeof urlString !== "string") return false;
    if (!urlString.startsWith("http://") && !urlString.startsWith("https://")) return false;
    
    const url = new URL(urlString);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    
    const allowedHosts = [
      "www.youtube.com", "youtube.com", "youtu.be",
      "m.youtube.com", "music.youtube.com"
    ];
    
    return allowedHosts.includes(url.hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}

app.post("/search", async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).send({ error: "Missing search query" });
  }
  
  try {
    const searchResult = await searchYouTube(url);
    
    if (!searchResult) {
      return res.status(404).send({ error: "No results found for: " + url });
    }
    
    res.send({ 
      status: "found", 
      title: searchResult.title,
      artist: searchResult.artist,
      duration: searchResult.duration,
      url: searchResult.url,
      metadata: searchResult
    });
  } catch (err) {
    console.error("Error in /search endpoint:", err);
    res.status(500).send({ error: err.message });
  }
});

app.post("/play", async (req, res) => {
  console.log("Received /play request:", req.body);
  const { url, isAutoplay = false, sourcePlaylist, ownerUsername, requesterUsername, dedicatedTo, dedicatedBy } = req.body;
  
  if (!url) {
    return res.status(400).send({ error: "Missing URL or search query" });
  }
  
  try {
    let videoUrl = url;
    let metadata = null;
    
    if (isValidYouTubeURL(url)) {
      videoUrl = url;
      
      let videoId = null;
      try {
        const urlObj = new URL(url);
        if (urlObj.hostname.includes('youtu.be')) {
          videoId = urlObj.pathname.substring(1);
        } else {
          videoId = urlObj.searchParams.get('v');
        }
      } catch (e) {}
      
      if (videoId) {
        try {
          const results = await yts({ videoId: videoId });
          if (results && results.title) {
            metadata = {
              url: url,
              title: results.title,
              artist: results.author?.name || results.author || "Unknown Artist",
              duration: results.timestamp || "Unknown",
              durationSeconds: results.seconds || 0,
              views: results.views ? results.views.toLocaleString() : "0",
              thumbnail: results.thumbnail || results.image || "",
              ago: results.ago || "",
              videoId: videoId
            };
          }
        } catch (err) {}
      }
    } else {
      const searchResult = await searchYouTube(url);
      
      if (!searchResult) {
        return res.status(404).send({ error: "No results found for: " + url });
      }
      
      videoUrl = searchResult.url;
      metadata = searchResult;
    }
    
    if (!metadata) {
      metadata = { title: "Unknown Track", artist: "Unknown Artist", duration: "Unknown" };
    }
    
    if (sourcePlaylist) {
      metadata.sourcePlaylist = sourcePlaylist;
      metadata.ownerUsername = ownerUsername;
    }
    if (requesterUsername) {
      metadata.requesterUsername = requesterUsername;
    }
    if (dedicatedTo) {
      metadata.dedicatedTo = dedicatedTo;
      metadata.dedicatedBy = dedicatedBy;
    }
    
    queue.push({ url: videoUrl, metadata, isAutoplay });
    saveQueue();
    
    if (isPlaying || isTransitioning || isPreparingTrack) {
      res.send({ 
        status: "queued", 
        position: queue.length,
        url: videoUrl, 
        currentTitle,
        currentMetadata,
        currentIsAutoplay,
        queuedTitle: metadata?.title,
        streamVersion: streamVersion
      });
    } else {
      playNext().catch(playErr => {
        console.error("Background playNext error:", playErr);
      });
      res.send({ 
        status: "playing", 
        url: videoUrl, 
        currentTitle: metadata?.title || "Starting playback...",
        currentMetadata: metadata,
        currentIsAutoplay,
        streamVersion: streamVersion
      });
    }
  } catch (err) {
    console.error("Error in /play endpoint:", err);
    res.status(500).send({ error: "Failed to add song to queue", message: err.message });
  }
});

app.post("/insert", async (req, res) => {
  const { url, requesterUsername, dedicatedTo, dedicatedBy } = req.body;
  
  if (!url) {
    return res.status(400).send({ error: "No URL or search query provided" });
  }
  
  console.log("⏫ INSERT command - Adding to front of queue:", url);
  let videoUrl = url;
  let metadata = null;
  
  try {
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      videoUrl = url;
      try {
        metadata = await getVideoMetadata(url);
      } catch (metaErr) {
        metadata = { title: "Unknown Track", artist: "Unknown Artist", duration: "Unknown" };
      }
    } else {
      const searchResult = await searchYouTube(url);
      
      if (!searchResult) {
        return res.status(404).send({ error: "No results found for: " + url });
      }
      
      videoUrl = searchResult.url;
      metadata = searchResult;
    }
    
    if (!metadata) {
      metadata = { title: "Unknown Track", artist: "Unknown Artist", duration: "Unknown" };
    }
    
    if (requesterUsername) {
      metadata.requesterUsername = requesterUsername;
      metadata.insertedBy = requesterUsername;
    }
    if (dedicatedTo) {
      metadata.dedicatedTo = dedicatedTo;
      metadata.dedicatedBy = dedicatedBy;
    }
    
    queue.unshift({ url: videoUrl, metadata, isAutoplay: false });
    saveQueue();
    
    if (isPlaying || isTransitioning || isPreparingTrack) {
      res.send({ 
        status: "inserted", 
        position: 1,
        url: videoUrl, 
        currentTitle,
        insertedTitle: metadata?.title,
        queueLength: queue.length,
        streamVersion: streamVersion
      });
    } else {
      playNext().catch(playErr => {
        console.error("Background playNext error in /insert:", playErr);
      });
      res.send({ 
        status: "playing", 
        url: videoUrl, 
        currentTitle: metadata?.title || "Starting playback...",
        currentMetadata: metadata,
        streamVersion: streamVersion
      });
    }
  } catch (err) {
    console.error("Error in /insert endpoint:", err);
    res.status(500).send({ error: "Failed to insert song", message: err.message });
  }
});

app.post("/stop", (req, res) => {
  console.log("⏹️ STOP command received");
  
  queue = [];
  saveQueue();
  
  stopPlayback();
  
  res.send({ 
    status: "stopped",
    message: "Playback stopped and queue cleared"
  });
});

app.post("/next", async (req, res) => {
  console.log("⏭️ SKIP command received");
  
  if (Date.now() - lastSkipTime < 3000) {
    return res.status(429).send({
      status: "cooldown",
      message: "Please wait a few seconds before skipping again."
    });
  }
  
  const skippedTitle = currentTitle;
  lastSkipTime = Date.now();
  
  currentStreamId++;
  killCurrentStream();
  
  isPreparingTrack = false;
  isTransitioning = false;
  isPlaying = false;
  
  playNext().catch(err => console.error("Error in skip playNext:", err));
  
  res.send({ 
    status: "skipped", 
    skippedTitle: skippedTitle,
    nowPlaying: queue.length > 0 ? (queue[0].metadata?.title || "Upcoming track") : "Waiting for next song...",
    queueLength: queue.length
  });
});

app.get("/current", (req, res) => {
  res.send({
    title: currentTitle,
    isPlaying: isPlaying,
    isTransitioning: isTransitioning || isPreparingTrack,
    isPreparing: isPreparingTrack,
    metadata: currentMetadata,
    isAutoplay: currentIsAutoplay,
    queueLength: queue.length,
    streamVersion: streamVersion,
    startTime: currentStartTime,
    serverElapsed: isPlaying && currentStartTime > 0 ? Math.max(0, Date.now() - currentStartTime) : 0,
    streamHealth: streamManager.getHealthStatus()
  });
});

app.get("/queue", (req, res) => {
  res.send({
    queue: queue.map((item, index) => ({
      position: index + 1,
      title: item.metadata?.title || "Unknown",
      artist: item.metadata?.artist || "Unknown",
      duration: item.metadata?.duration || "Unknown",
      isAutoplay: item.isAutoplay || false,
      url: item.url,
      videoId: item.metadata?.videoId
    })),
    currentlyPlaying: {
      title: currentTitle,
      metadata: currentMetadata,
      isAutoplay: currentIsAutoplay
    },
    queueLength: queue.length
  });
});

app.get("/stats", (req, res) => {
  res.send({
    status: "ok",
    ...streamManager.getStats(),
    currentTitle,
    isPlaying,
    queueLength: queue.length
  });
});

app.get("/health", (req, res) => {
  const health = streamManager.getHealthStatus();
  res.send({
    status: health.encoderAlive ? "healthy" : "unhealthy",
    ...health,
    isPlaying,
    currentTitle,
    queueLength: queue.length
  });
});

app.get("/volume", (req, res) => {
  res.send({
    status: "ok",
    volume: volume,
    min: 0,
    max: 200
  });
});

app.post("/volume", (req, res) => {
  const { level } = req.body;
  
  if (level === undefined || level === null) {
    return res.status(400).send({ 
      error: "Missing level parameter",
      min: 0,
      max: 200,
      current: volume
    });
  }
  
  const newVolume = parseInt(level, 10);
  
  if (isNaN(newVolume) || newVolume < 0 || newVolume > 200) {
    return res.status(400).send({ 
      error: "Volume must be between 0 and 200",
      current: volume
    });
  }
  
  const oldVolume = volume;
  volume = newVolume;
  
  saveSettings();
  broadcastEvent();
  
  console.log(`🔊 Volume changed: ${oldVolume}% → ${volume}%`);
  
  res.send({
    status: "ok",
    message: "Volume updated. Will apply to next track.",
    oldVolume: oldVolume,
    newVolume: volume
  });
});

app.get("/announcements", (req, res) => {
  res.send({
    status: "ok",
    enabled: announcementsEnabled,
    voice: announcementVoice,
    voiceName: VOICE_OPTIONS[announcementVoice] || 'English (US)',
    wordLimit: announcementWordLimit,
    availableVoices: VOICE_OPTIONS
  });
});

app.post("/announcements", (req, res) => {
  const { enabled, voice, wordLimit } = req.body;
  
  if (enabled !== undefined) {
    announcementsEnabled = Boolean(enabled);
  }
  
  if (voice !== undefined) {
    if (VOICE_OPTIONS[voice]) {
      announcementVoice = voice;
    } else {
      return res.status(400).send({
        status: "error",
        error: `Invalid voice code. Available: ${Object.keys(VOICE_OPTIONS).join(', ')}`
      });
    }
  }
  
  if (wordLimit !== undefined) {
    const limit = parseInt(wordLimit);
    if (isNaN(limit) || limit < 3 || limit > 50) {
      return res.status(400).send({
        status: "error",
        error: "Word limit must be between 3 and 50"
      });
    }
    announcementWordLimit = limit;
  }
  
  saveSettings();
  broadcastEvent();
  
  res.send({
    status: "ok",
    enabled: announcementsEnabled,
    voice: announcementVoice,
    voiceName: VOICE_OPTIONS[announcementVoice] || 'English (US)',
    wordLimit: announcementWordLimit,
    message: announcementsEnabled 
      ? "TTS announcements enabled! Song info will play during transitions."
      : "TTS announcements disabled."
  });
});

app.get("/quality", (req, res) => {
  res.send({
    status: "ok",
    bitrate: audioBitrate,
    availableOptions: AVAILABLE_BITRATES
  });
});

app.post("/quality", (req, res) => {
  const { bitrate } = req.body;
  
  if (!bitrate) {
    return res.status(400).send({ 
      error: "Missing bitrate parameter",
      availableOptions: AVAILABLE_BITRATES,
      current: audioBitrate
    });
  }
  
  const normalizedBitrate = bitrate.toLowerCase().replace('kbps', 'k').replace('k', 'k');
  
  if (!AVAILABLE_BITRATES.includes(normalizedBitrate)) {
    return res.status(400).send({ 
      error: `Invalid bitrate. Available options: ${AVAILABLE_BITRATES.join(', ')}`,
      availableOptions: AVAILABLE_BITRATES,
      current: audioBitrate
    });
  }
  
  const oldBitrate = audioBitrate;
  audioBitrate = normalizedBitrate;
  
  saveSettings();
  
  console.log(`🎚️ Audio quality changed: ${oldBitrate} → ${audioBitrate}`);
  
  res.send({
    status: "ok",
    message: "Quality updated. Restart stream to apply new bitrate.",
    oldBitrate: oldBitrate,
    newBitrate: audioBitrate,
    note: "The encoder will use the new bitrate on next restart"
  });
});

app.post("/resolve", async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).send({ error: "Missing query parameter" });
  }
  
  try {
    let metadata = null;
    
    if (isValidYouTubeURL(query)) {
      let videoId = null;
      try {
        const urlObj = new URL(query);
        if (urlObj.hostname.includes('youtu.be')) {
          videoId = urlObj.pathname.substring(1);
        } else {
          videoId = urlObj.searchParams.get('v');
        }
      } catch (e) {}
      
      if (videoId) {
        try {
          const results = await yts({ videoId: videoId });
          if (results && results.title) {
            metadata = {
              url: query,
              title: results.title,
              artist: results.author?.name || results.author || "Unknown Artist",
              duration: results.timestamp || "Unknown",
              durationSeconds: results.seconds || 0,
              views: results.views ? results.views.toLocaleString() : "0",
              thumbnail: results.thumbnail || results.image || "",
              ago: results.ago || "",
              videoId: videoId
            };
          }
        } catch (err) {}
      }
    } else {
      metadata = await searchYouTube(query);
    }
    
    if (!metadata) {
      return res.status(404).send({ error: "No results found", query: query });
    }
    
    res.send({ status: "resolved", metadata: metadata });
    
  } catch (err) {
    console.error("/resolve error:", err);
    res.status(500).send({ error: "Failed to resolve query", message: err.message });
  }
});

app.post("/restore", async (req, res) => {
  console.log("🔄 RESTORE command received");
  
  if (isPlaying || isPreparingTrack || isTransitioning) {
    return res.send({
      status: "already_playing",
      nowPlaying: currentTitle,
      queueLength: queue.length
    });
  }

  if (queue.length > 0) {
    await playNext();
    res.send({ 
      status: "restored",
      queueLength: queue.length,
      nowPlaying: currentTitle,
      message: "Playback restored from saved queue"
    });
  } else {
    res.send({
      status: "empty",
      message: "No saved queue to restore"
    });
  }
});

app.post("/clear", (req, res) => {
  const clearedCount = queue.length;
  queue = [];
  saveQueue();
  console.log(`🗑️ Queue cleared (${clearedCount} tracks removed)`);
  res.send({ 
    status: "cleared", 
    clearedCount,
    currentTitle 
  });
});

let isPlayNextLocked = false;
async function playNext() {
  if (isPlayNextLocked) {
    console.log("⚠️ playNext already executing, skipping duplicate concurrent invocation");
    return;
  }
  isPlayNextLocked = true;
  let next;
  try {
    next = queue.shift();
  } finally {
    isPlayNextLocked = false;
  }
  saveQueue();
  console.log("playNext called. Next item:", next);
  
  if (!next) {
    isPreparingTrack = false;
    isTransitioning = false;
    softStopPlayback();
    
    // Fix: if a song was added to the queue exactly while we were stopping, start it!
    if (queue.length > 0) {
      console.log("⚠️ Song was queued while stopping. Resuming playback!");
      playNext();
    }
    return;
  }
  
  isPreparingTrack = true;
  isTransitioning = true;
  isPlaying = false;
  
  try {
    if (typeof next === 'string') {
      currentIsAutoplay = false;
      await startStream(next);
    } else {
      currentIsAutoplay = next.isAutoplay || false;
      await startStream(next.url, next.metadata?.title, next.metadata);
    }
  } catch (err) {
    console.error("❌ Error in playNext:", err.message);
    isPreparingTrack = false;
    isTransitioning = false;
    softStopPlayback();
    setTimeout(() => {
      if (!isPlaying && !isTransitioning && !isPreparingTrack && queue.length > 0) playNext();
    }, 2000);
  }
}

app.get(["/stream", "/STREAM"], (req, res) => {
  if (res.socket) {
    res.socket.setNoDelay(true);
  }
  
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
    "X-Stream-Version": String(streamVersion),
    "X-Stream-Live": "true",
    "icy-name": "Highrise Music Stream",
    "icy-br": audioBitrate.replace('k', ''),
    "icy-pub": "1"
  });

  streamManager.addClient(res, req);
});

app.get("/", (req, res) => {
  const stats = streamManager.getStats();
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🎵 Music Streaming Server</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
          color: #fff;
        }
        .container { max-width: 900px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .header h1 { font-size: 3em; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
        .status-badge {
          display: inline-block;
          background: rgba(255,255,255,0.2);
          padding: 8px 20px;
          border-radius: 20px;
          backdrop-filter: blur(10px);
          font-size: 0.9em;
        }
        .pulse {
          display: inline-block;
          width: 10px;
          height: 10px;
          background: #4ade80;
          border-radius: 50%;
          margin-right: 8px;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.1); }
        }
        .card {
          background: rgba(255, 255, 255, 0.15);
          backdrop-filter: blur(10px);
          border-radius: 20px;
          padding: 30px;
          margin-bottom: 20px;
          box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
          border: 1px solid rgba(255, 255, 255, 0.18);
        }
        .now-playing { display: flex; align-items: center; gap: 20px; }
        .music-icon { font-size: 3em; animation: rotate 3s linear infinite; }
        @keyframes rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .track-info h2 { font-size: 1.5em; margin-bottom: 5px; }
        .track-info p { opacity: 0.8; font-size: 0.95em; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .stat-box {
          background: rgba(255, 255, 255, 0.1);
          padding: 20px;
          border-radius: 15px;
          text-align: center;
        }
        .stat-box .number { font-size: 2em; font-weight: bold; margin-bottom: 5px; }
        .stat-box .label { opacity: 0.8; font-size: 0.9em; }
        .stream-btn {
          display: inline-block;
          background: linear-gradient(45deg, #4ade80, #22c55e);
          color: white;
          padding: 15px 40px;
          border-radius: 30px;
          text-decoration: none;
          font-weight: bold;
          margin-top: 20px;
        }
        .persistent-badge {
          background: linear-gradient(45deg, #22c55e, #16a34a);
          padding: 5px 15px;
          border-radius: 20px;
          font-size: 0.8em;
          margin-left: 10px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎵 Music Streaming Server</h1>
          <div class="status-badge">
            <span class="pulse"></span>
            Server Online
            <span class="persistent-badge">Persistent Stream</span>
          </div>
        </div>
        
        <div class="card">
          <div class="now-playing">
            <div class="music-icon">💿</div>
            <div class="track-info">
              <h2>Now Playing</h2>
              <p>${currentTitle || 'No track playing'}</p>
            </div>
          </div>
          
          <div class="stats">
            <div class="stat-box">
              <div class="number">${queue.length}</div>
              <div class="label">Tracks in Queue</div>
            </div>
            <div class="stat-box">
              <div class="number">${stats.activeListeners}</div>
              <div class="label">Active Listeners</div>
            </div>
            <div class="stat-box">
              <div class="number">${stats.encoderRunning ? '✓' : '✗'}</div>
              <div class="label">Encoder Status</div>
            </div>
          </div>
          
          <center>
            <a href="/stream" class="stream-btn">🎧 Listen Now</a>
          </center>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.post("/api/bot-command", async (req, res) => {
  try {
    const { command, ...data } = req.body;
    
    // Server-side validation for moderation commands
    if (command === "kick" || command === "teleport") {
      if (!data.userId) {
        return res.status(400).send({ error: "userId is required for this command" });
      }
      
      // Fetch roster to validate user exists
      const rosterRes = await fetch(`http://127.0.0.1:5001/api/roster`, {
        headers: { "X-IPC-Secret": process.env.IPC_SECRET }
      });
      const rosterData = await rosterRes.json();
      
      const userExists = rosterData.users?.some(u => u.id === data.userId || u.username.toLowerCase() === data.userId.toLowerCase());
      if (!userExists) {
        return res.status(404).send({ error: "User is not currently in the room." });
      }
      
      // If they provided a username, map it to ID for the bot
      if (userExists) {
        const matchedUser = rosterData.users.find(u => u.id === data.userId || u.username.toLowerCase() === data.userId.toLowerCase());
        data.userId = matchedUser.id; // Force using the ID
      }
      
      // Validate teleport coords
      if (command === "teleport") {
        data.x = parseFloat(data.x) || 0;
        data.y = parseFloat(data.y) || 0;
        data.z = parseFloat(data.z) || 0;
      }
    }
    
    const response = await fetch(`http://127.0.0.1:5001/api/${command}`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET
      },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to communicate with bot process" });
  }
});

app.get("/api/config", (req, res) => {
  res.send({
    roomIdSet: !!process.env.ROOM_ID,
    apiTokenSet: !!process.env.API_TOKEN,
    port: process.env.PORT || 5000
  });
});

app.post("/api/config", (req, res) => {
  try {
    const { ROOM_ID, API_TOKEN } = req.body;
    let envContent = fs.readFileSync('.env', 'utf8');
    if (ROOM_ID) {
      envContent = envContent.replace(/ROOM_ID=.*/g, `ROOM_ID=${ROOM_ID}`);
    }
    if (API_TOKEN) {
      envContent = envContent.replace(/API_TOKEN=.*/g, `API_TOKEN=${API_TOKEN}`);
    }
    fs.writeFileSync('.env', envContent);
    res.send({ status: "success", message: "Config saved. Restart required." });
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

app.get("/api/access", (req, res) => {
  try {
    const adminsPath = path.join(__dirname, "systems/admin/data/admins.json");
    if (fs.existsSync(adminsPath)) {
      const data = JSON.parse(fs.readFileSync(adminsPath, 'utf8'));
      res.send(data);
    } else {
      res.send({ admins: [], vips: [], owner: "" });
    }
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

app.post("/api/access", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/access`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET
      },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to communicate with bot process" });
  }
});

app.get("/api/economy", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/economy`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get economy data" });
  }
});

app.post("/api/economy", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/economy`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET
      },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to update economy data" });
  }
});

app.post("/api/terminal", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/terminal`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET
      },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to execute terminal command" });
  }
});

app.post("/api/mode", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/mode`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET
      },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to change mode" });
  }
});

app.delete("/api/queue/:index", (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0 || index >= queue.length) {
    return res.status(400).send({ error: "Invalid queue index" });
  }
  const removed = queue.splice(index, 1);
  saveQueue();
  broadcastState();
  res.send({ status: "success", removed: removed[0].metadata.title });
});

app.get("/api/stats", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/stats`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get stats" });
  }
});

app.get("/api/playlists", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/playlists`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get playlists" });
  }
});

app.get("/api/outfits", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/outfits`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get outfits" });
  }
});

app.get("/api/locations", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/locations`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get locations" });
  }
});

app.get("/api/shop", async (req, res) => {
  try {
    const q = req.query.q || '';
    const response = await fetch(`http://127.0.0.1:5001/api/shop?q=${encodeURIComponent(q)}`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to query shop" });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/history`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to query history" });
  }
});

app.post("/api/bot-command", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/bot-command`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-IPC-Secret": process.env.IPC_SECRET 
      },
      body: JSON.stringify(req.body)
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to dispatch bot command" });
  }
});

app.post("/api/broadcast", (req, res) => {
  if (req.body) {
    broadcastEventJSON(req.body);
  }
  res.send({ success: true });
});

app.get("/api/roster", async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/roster`, {
      method: "GET",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    });
    const result = await response.json();
    res.status(response.status).send(result);
  } catch (e) {
    res.status(500).send({ error: "Failed to get roster" });
  }
});

app.post("/api/restart", async (req, res) => {
  console.log("🔄 FULL RESTART command received");
  
  res.send({ 
    status: "restarting",
    message: "System is restarting...",
    timestamp: Date.now()
  });
  
  savePlaybackState();
  saveQueue();
  
  try {
    // Try to restart Python bot via IPC
    await fetch(`http://127.0.0.1:5001/api/restart`, {
      method: "POST",
      headers: { "X-IPC-Secret": process.env.IPC_SECRET }
    }).catch(e => null);
  } catch(e) {}
  
  setTimeout(() => {
    process.exit(1);
  }, 500);
});

app.post("/restart", (req, res) => {
  console.log("🔄 RESTART command received");
  
  res.send({ 
    status: "restarting",
    message: "Music server is restarting...",
    timestamp: Date.now()
  });
  
  savePlaybackState();
  saveQueue();
  
  setTimeout(() => {
    process.exit(1);
  }, 500);
});

queue = loadQueue();
const playbackState = loadPlaybackState();

streamManager.startPersistentEncoder();

setInterval(() => {
  const health = streamManager.getHealthStatus();
  if (!health.encoderAlive) {
    console.error('⚠️ Health check: Encoder not alive, restarting...');
    streamManager.startPersistentEncoder();
  }
}, 30000);

// Periodic memory maintenance: sweep expired cache and invoke GC if exposed
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of metadataCache.entries()) {
    if (now - val.timestamp > CACHE_TTL) {
      metadataCache.delete(key);
    }
  }
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }
}, 5 * 60 * 1000);


// 🛡️ High-Frequency Memory Guard & Aggressive Garbage Collection
setInterval(() => {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  // Only log if RSS exceeds 100MB as an early warning
  if (mem.rss > 100 * 1024 * 1024) {
    console.warn(`⚠️ [MemoryGuard] Elevated Node memory: RSS ${rssMb}MB, Heap ${heapMb}MB - running cleanup...`);
    pruneStaleCacheFiles(currentLocalFilePath);
    if (typeof global.gc === 'function') global.gc();
  }
}, 30000);

registerLiveLogs(app);

const rawPort = process.env.PORT || process.env.SERVER_PORT || 5000;
const PORT = parseInt(String(rawPort).trim(), 10) || 5000;

function listenWithRetry(port, retriesLeft = 10) {
  const server = app.listen(port, "0.0.0.0", async () => {
    await ensureYtDlp();
    

    
    console.log(`🚀 Music server running on port ${port}`);
    console.log("📡 Persistent streaming architecture active!");
    console.log("🔧 FFmpeg encoder runs continuously - no disconnections between songs");
    
    if (playbackState.isPlaying && playbackState.currentTitle && playbackState.currentMetadata) {
      console.log(`🔄 Restoring previously playing song: ${playbackState.currentTitle}`);
      
      const restoredVideoId = playbackState.currentMetadata.videoId;
      const alreadyInQueue = queue.some(item => 
        item.metadata?.videoId === restoredVideoId || 
        item.url === playbackState.currentMetadata.url
      );
      
      if (alreadyInQueue) {
        console.log(`⚠️ Song already in queue, not adding duplicate`);
        const existingIndex = queue.findIndex(item => 
          item.metadata?.videoId === restoredVideoId || 
          item.url === playbackState.currentMetadata.url
        );
        if (existingIndex > 0) {
          const [existingSong] = queue.splice(existingIndex, 1);
          queue.unshift(existingSong);
          console.log(`↩️ Moved existing song to front of queue`);
        }
      } else {
        queue.unshift({
          url: playbackState.currentMetadata.url,
          metadata: playbackState.currentMetadata,
          isAutoplay: playbackState.currentIsAutoplay || false
        });
        console.log(`✅ Restored 1 songs from previous session`);
      }
      saveQueue();
    }
    
    if (queue.length > 0) {
      console.log(`📋 Queue has ${queue.length} songs ready to play`);
      console.log("▶️ Auto-starting playback from saved queue...");
      
      setTimeout(() => {
        playNext();
      }, 2000);
    }
  });

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.timeout = 0;

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      console.log(`⚠️ Port ${port} is in use (socket releasing). Retrying in 3 seconds... (${retriesLeft} retries left)`);
      setTimeout(() => {
        listenWithRetry(port, retriesLeft - 1);
      }, 3000);
    } else {
      console.error("❌ Music server error:", err);
    }
  });
}

listenWithRetry(PORT);


// ============================================================================
// 🛡️ Render 24/7 Keep-Alive Sentinel (Prevents Free-Tier Inactivity Sleep)
// ============================================================================
function armRenderKeepAlive() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!externalUrl || externalUrl.includes('127.0.0.1') || externalUrl.includes('localhost')) {
    return;
  }

  const pingEndpoint = externalUrl.replace(/\/+$/, '') + '/ping';
  console.log(`🛡️ [Keep-Alive Sentinel] Armed 24/7 anti-sleep pinger -> ${pingEndpoint}`);

  // Ping every 7 minutes (Render free tier spins down after 15 minutes of no HTTP traffic)
  setInterval(async () => {
    try {
      const res = await fetch(pingEndpoint, { 
        headers: { 'User-Agent': 'MusicEngine-KeepAlive/1.0' },
        timeout: 10000 
      });
      if (res.ok) {
        console.log(`💓 [Keep-Alive Sentinel] Ping successful at ${new Date().toISOString().slice(11, 19)} (Render sleep timer reset)`);
      }
    } catch (err) {
      console.warn(`⚠️ [Keep-Alive Sentinel] Ping attempt failed: ${err.message}`);
    }
  }, 7 * 60 * 1000);
}

armRenderKeepAlive();
