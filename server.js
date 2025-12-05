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

/* ============================
   CONFIGURATION
============================ */
const PORT = process.env.PORT || 3000;
const PAIR_SECRET = process.env.PAIR_SECRET || "SLEEK_FDROID";
const SESSION_ROOT = process.env.SESSION_ROOT || path.join(__dirname, "sessions");
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "pairer.log");
const CLEANUP_MINUTES = parseInt(process.env.CLEANUP_MINUTES || "10");
fs.ensureDirSync(SESSION_ROOT);

// Active session registry
const sessions = new Map();

/* ============================
   MIDDLEWARES
============================ */
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(morgan("tiny"));

// Rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests — slow down." }
});
app.use("/api/", limiter);

function log(txt) {
  fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${txt}${os.EOL}`);
}

function newSessionId(phone) {
  return `${phone}_${Date.now()}`;
}

/* ============================
   MAIN: GENERATE PAIR CODE
============================ */
app.get("/api/pair-code", async (req, res) => {
  try {
    const phone = (req.query.phone || "").replace(/[^0-9]/g, "");
    const token = req.query.token;

    if (!phone) return res.json({ error: "Missing phone parameter" });
    if (token !== PAIR_SECRET) return res.json({ error: "Invalid token" });

    const sessionId = newSessionId(phone);
    const folder = path.join(SESSION_ROOT, sessionId);
    fs.ensureDirSync(folder);

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["SLEEK-MD Pairer", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sessions.set(sessionId, {
      phone,
      folder,
      createdAt: Date.now()
    });

    // Baileys pairing
    const codeObj = await sock.requestPairingCode(phone);
    const pairCode = codeObj.code || codeObj;

    const qr = await qrcode.toDataURL(pairCode);

    return res.json({
      status: "success",
      sessionId,
      pairCode,
      qrCode: qr
    });

  } catch (err) {
    console.error(err);
    return res.json({ error: err.message });
  }
});

/* ============================
   DOWNLOAD SESSION
============================ */
app.get("/api/download-session", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const token = req.query.token;

    if (!token || token !== PAIR_SECRET)
      return res.json({ error: "Invalid token" });

    const session = sessions.get(sessionId);
    if (!session) return res.json({ error: "Session not found" });

    const folder = session.folder;

    res.setHeader("Content-Disposition", `attachment; filename="${sessionId}.zip"`);
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip");
    archive.pipe(res);
    archive.directory(folder, false);
    archive.finalize();

    // Cleanup after sending
    res.on("finish", () => {
      fs.remove(folder);
      sessions.delete(sessionId);
    });

  } catch (err) {
    console.error(err);
    res.json({ error: "Download failed" });
  }
});

/* ============================
   CLEANUP OLD SESSIONS
============================ */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > CLEANUP_MINUTES * 60000) {
      fs.remove(s.folder);
      sessions.delete(id);
    }
  }
}, 60 * 1000);

/* ============================
   STATIC FRONTEND
============================ */
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("SLEEK MD Pairer running on port", PORT);
});