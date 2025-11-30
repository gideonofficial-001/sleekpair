// server.js -- Advanced SLEEK MD Pairer (CommonJS)
// Requires Node 18 or 20.

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const fs = require("fs-extra");
const path = require("path");
const archiver = require("archiver");
const qrcode = require("qrcode");
const os = require("os");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const PAIR_SECRET = process.env.PAIR_SECRET || "SLEEK_FDROID";
const SESSION_ROOT = process.env.SESSION_ROOT || path.join(__dirname, "sessions");
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "pairer.log");
const CLEANUP_MINUTES = parseInt(process.env.CLEANUP_MINUTES || "10", 10);
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
fs.ensureDirSync(SESSION_ROOT);

// in-memory session registry
const sessions = new Map();

// ---------- Middlewares ----------
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const accessLogStream = fs.createWriteStream(path.join(__dirname, "access.log"), { flags: "a" });
app.use(morgan("combined", { stream: accessLogStream }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "Too many requests, slow down." }
});
app.use("/api/", limiter);

// helpers
function appendLog(line) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}${os.EOL}`;
  fs.appendFile(LOG_FILE, text).catch(console.error);
}

function checkIpAllowed(req, res, next) {
  if (ALLOWED_IPS.length === 0) return next();
  const ip = (req.ip || req.connection.remoteAddress || "").replace("::ffff:", "");
  if (!ALLOWED_IPS.includes(ip)) {
    appendLog(`Blocked IP ${ip}`);
    return res.status(403).json({ error: "Forbidden (IP not allowed)" });
  }
  next();
}

function validateToken(req, res, next) {
  const token = req.query.token || req.headers["x-pair-token"] || req.body.token;
  if (!token) return res.status(401).json({ error: "Missing token" });
  if (token !== PAIR_SECRET) return res.status(403).json({ error: "Invalid token" });
  next();
}

function newSessionId(phone) {
  const ts = Date.now();
  const safePhone = phone.replace(/[^0-9]/g, "") || "anon";
  return `${safePhone}_${ts}`;
}

async function removeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    await fs.remove(s.folder);
    appendLog(`Removed session ${sessionId} (phone: ${s.phone})`);
  } catch (e) {
    appendLog(`Error removing session ${sessionId}: ${e.message}`);
  }
  sessions.delete(sessionId);
}

// auto cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    const ageMs = now - s.createdAt;
    if (ageMs > CLEANUP_MINUTES * 60 * 1000) {
      appendLog(`Auto-clean: session ${id} aged ${Math.round(ageMs/1000)}s`);
      removeSession(id).catch(console.error);
    }
  }
}, 60 * 1000);

// ---------- API: Generate Pair Code ----------
app.get("/api/pair-code", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const phoneRaw = (req.query.phone || "").toString();
    const phone = phoneRaw.replace(/[^0-9]/g, "");
    if (!phone) return res.status(400).json({ error: "Missing or invalid phone parameter" });

    const sessionId = newSessionId(phone);
    const folder = path.join(SESSION_ROOT, sessionId);
    await fs.ensureDir(folder);

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["SLEEK-MD-Pairer", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sessions.set(sessionId, {
      phone,
      folder,
      createdAt: Date.now(),
      socketAlive: true
    });

    appendLog(`Created session ${sessionId} for phone ${phone}`);

    if (typeof sock.requestPairingCode !== "function") {
      appendLog(`Pairing method missing for session ${sessionId}`);
      try { await sock.logout?.(); } catch(e){}
      await removeSession(sessionId);
      return res.status(500).json({ error: "This Baileys build does not support requestPairingCode()" });
    }

    const codeObj = await sock.requestPairingCode(phone);
    const pairCode = (typeof codeObj === "object" && codeObj?.code) ? codeObj.code : String(codeObj);
    const qrDataUrl = await qrcode.toDataURL(pairCode);

    appendLog(`Pair code generated for session ${sessionId}`);

    return res.json({
      status: "success",
      sessionId,
      pairCode,
      qrCode: qrDataUrl,
      message: "Use this code or QR in WhatsApp → Linked Devices → Link a device"
    });
  } catch (err) {
    appendLog(`pair-code error: ${err?.message || err}`);
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ---------- API: Download Session ----------
app.get("/api/download-session", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    const meta = sessions.get(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found or expired" });

    const folder = meta.folder;
    const zipName = `${sessionId}.zip`;

    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      appendLog(`Archive error for ${sessionId}: ${err.message}`);
      res.status(500).end();
    });
    archive.pipe(res);
    archive.directory(folder, false);
    archive.finalize();

    res.on("finish", async () => {
      appendLog(`Session ${sessionId} downloaded — cleaning up`);
      try { await removeSession(sessionId); } catch (e) { appendLog(`Error cleanup after download ${sessionId}: ${e.message}`); }
    });
  } catch (err) {
    appendLog(`download-session error: ${err?.message || err}`);
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// admin endpoints
app.get("/api/sessions", checkIpAllowed, validateToken, (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({ sessionId: id, phone: s.phone, createdAt: s.createdAt, socketAlive: s.socketAlive });
  }
  res.json({ count: list.length, sessions: list });
});

app.get("/api/logs", checkIpAllowed, validateToken, async (req, res) => {
  try {
    const lines = Math.min(1000, parseInt(req.query.lines || "200", 10));
    if (!await fs.pathExists(LOG_FILE)) {
      return res.json({ logs: [] });
    }
    const txt = await fs.readFile(LOG_FILE, "utf8");
    const arr = txt.trim().split(/\\r?\\n/).slice(-lines);
    res.json({ logs: arr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error reading logs" });
  }
});

// serve UI
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  appendLog(`SLEEK MD Pairer started on port ${PORT}. Sessions root: ${SESSION_ROOT}`);
  console.log(`SLEEK MD Pairer running on port ${PORT}`);
});
