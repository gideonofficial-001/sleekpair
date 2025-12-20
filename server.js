const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const fs = require("fs-extra");
const path = require("path");
const archiver = require("archiver");
const qrcode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;
const PAIR_SECRET = process.env.PAIR_SECRET || "SLEEK_FDROID";
const SESSION_ROOT = path.join(__dirname, "sessions");
fs.ensureDirSync(SESSION_ROOT);

const sessions = new Map();

/* ================= MIDDLEWARE ================= */
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 15
  })
);

/* ================= HELPERS ================= */
function isValidPhone(phone) {
  // 10–15 digits, international format, no leading 0
  return /^[1-9][0-9]{9,14}$/.test(phone);
}

function newSessionId(phone) {
  return `${phone}_${Date.now()}`;
}

/* ================= PAIR CODE ================= */
app.get("/api/pair-code", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    const token = req.query.token;

    if (token !== PAIR_SECRET) {
      return res.json({ error: "Invalid token" });
    }

    if (!isValidPhone(phone)) {
      return res.json({
        error: "Invalid phone number. Use international format e.g. 254712345678"
      });
    }

    const sessionId = newSessionId(phone);
    const sessionDir = path.join(SESSION_ROOT, sessionId);
    fs.ensureDirSync(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["SLEEK-MD", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sessions.set(sessionId, {
      dir: sessionDir,
      created: Date.now()
    });

    const pairing = await sock.requestPairingCode(phone);
    const pairCode = pairing.code || pairing;

    const qr = await qrcode.toDataURL(pairCode);

    res.json({
      status: "success",
      pairCode,
      sessionId,
      qrCode: qr
    });

  } catch (err) {
    console.error(err);
    res.json({ error: "Failed to generate pair code" });
  }
});

/* ================= DOWNLOAD SESSION ================= */
app.get("/api/download-session", async (req, res) => {
  const { sessionId, token } = req.query;

  if (token !== PAIR_SECRET) {
    return res.json({ error: "Invalid token" });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ error: "Session not found or expired" });
  }

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${sessionId}.zip"`
  );
  res.setHeader("Content-Type", "application/zip");

  const archive = archiver("zip");
  archive.pipe(res);
  archive.directory(session.dir, false);
  archive.finalize();

  res.on("finish", () => {
    fs.remove(session.dir);
    sessions.delete(sessionId);
  });
});

/* ================= STATIC ================= */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

app.listen(PORT, () =>
  console.log("✅ SLEEK MD Pair Generator running on", PORT)
);