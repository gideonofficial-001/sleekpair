const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSIONS_FOLDER = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_FOLDER)) fs.mkdirSync(SESSIONS_FOLDER, { recursive: true });

const activeSessions = new Map();
const logger = pino({ level: 'silent' });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionPath(id) {
  return path.join(SESSIONS_FOLDER, id);
}

function nukeSessionFolder(id) {
  const folder = sessionPath(id);
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

function clearSession(id) {
  const s = activeSessions.get(id);
  if (s?.sock) {
    try { s.sock.ws?.close(); } catch (_) {}
    try { s.sock.end(undefined); } catch (_) {}
  }
  activeSessions.delete(id);
  nukeSessionFolder(id);
}

function encodeSession(id) {
  const folder = sessionPath(id);
  if (!fs.existsSync(folder)) return null;
  const bundle = {};
  for (const file of fs.readdirSync(folder)) {
    try { bundle[file] = fs.readFileSync(path.join(folder, file), 'utf-8'); }
    catch (_) {}
  }
  const json = JSON.stringify(bundle);
  if (Object.keys(bundle).length === 0) return null;
  return Buffer.from(json).toString('base64');
}

async function sendSessionToUser(sock, phoneNumber, sessionId, b64) {
  const jid = phoneNumber + '@s.whatsapp.net';
  const msg = [
    `╭──────────────────────────╮`,
    `│  *sleek-md Connected!* ✅  │`,
    `╰──────────────────────────╯`,
    ``,
    `*Session ID:* \`${sessionId}\``,
    ``,
    `*Session String (keep safe 🔐):*`,
    `\`\`\`${b64}\`\`\``,
    ``,
    `⚠️ _Do NOT share this with anyone._`,
    `— sleek-md by Sleek Tech`,
  ].join('\n');
  await sock.sendMessage(jid, { text: msg });
}

// ── Core pairing ──────────────────────────────────────────────────────────────

async function startPairingSession(sessionId, phoneNumber) {
  // Always start with a clean folder — stale creds cause "connection closed"
  nukeSessionFolder(sessionId);
  const sessionDir = sessionPath(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,                          // plain state, no makeCacheableSignalKeyStore
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),   // standard trusted fingerprint
    mobile: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  activeSessions.set(sessionId, { sock, status: 'waiting', phoneNumber });
  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    let resolved = false;

    const done = (val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      if (val instanceof Error) reject(val);
      else resolve(val);
    };

    // Hard timeout — 60 s
    const hardTimeout = setTimeout(() => {
      done(new Error('Timed out waiting for WhatsApp. Check the phone number and try again.'));
      clearSession(sessionId);
    }, 60_000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // ── QR event = WhatsApp is ready → swap in pairing code ──────────────
      // This is the correct trigger. Do NOT call requestPairingCode() before this.
      if (qr && !resolved) {
        console.log(`[${sessionId}] QR received — requesting pairing code for +${phoneNumber}`);
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
          activeSessions.get(sessionId).status = 'code_issued';
          console.log(`[${sessionId}] Code: ${formatted}`);
          done({ formatted });
        } catch (err) {
          console.error(`[${sessionId}] requestPairingCode failed:`, err.message);
          done(new Error('Could not get pairing code: ' + err.message));
          clearSession(sessionId);
        }
        return;
      }

      // ── Fully linked ──────────────────────────────────────────────────────
      if (connection === 'open') {
        const session = activeSessions.get(sessionId);
        if (session) session.status = 'connected';
        console.log(`[${sessionId}] ✅ Linked!`);

        setTimeout(async () => {
          try {
            const b64 = encodeSession(sessionId);
            if (b64) {
              await sendSessionToUser(sock, phoneNumber, sessionId, b64);
              console.log(`[${sessionId}] 📤 Session string sent`);
            }
          } catch (err) {
            console.error(`[${sessionId}] Send session failed:`, err.message);
          }
        }, 3000);
      }

      // ── Closed ───────────────────────────────────────────────────────────
      if (connection === 'close') {
        const reason = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : 0;

        console.log(`[${sessionId}] Closed — reason ${reason}`);

        if (reason === DisconnectReason.loggedOut) {
          clearSession(sessionId);
          return;
        }

        const session = activeSessions.get(sessionId);
        if (session) session.status = 'disconnected';

        // If we closed before issuing a code, surface the error
        if (!resolved) {
          const msg = reason === 401
            ? 'WhatsApp rejected the session (401). The session folder was cleared — please try again.'
            : reason === 408
            ? 'Connection timed out from WhatsApp. Try again in a moment.'
            : reason === 440
            ? 'Another WhatsApp session opened on this account. Try again.'
            : `Connection closed before code was issued (code ${reason}). Please try again.`;

          done(new Error(msg));
          clearSession(sessionId);
        }
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/request-code', async (req, res) => {
  let { phoneNumber, sessionId } = req.body;

  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required.' });

  const cleanNumber = phoneNumber.replace(/\D/g, '');
  if (cleanNumber.length < 7 || cleanNumber.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number — include country code, digits only.' });
  }

  sessionId = (sessionId || `sleek_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');

  // Kill any stuck session with the same ID
  if (activeSessions.has(sessionId)) {
    const s = activeSessions.get(sessionId);
    if (s.status === 'waiting' || s.status === 'code_issued') {
      return res.status(409).json({ error: 'Pairing already in progress for this session.' });
    }
    clearSession(sessionId);
  }

  try {
    const { formatted } = await startPairingSession(sessionId, cleanNumber);
    return res.json({
      success: true,
      sessionId,
      phoneNumber: cleanNumber,
      formatted,
      expiresInSeconds: 160,
      note: 'After you enter the code in WhatsApp, your session string will be sent to your inbox.',
    });
  } catch (err) {
    console.error(`[${sessionId}]`, err.message);
    clearSession(sessionId);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:sessionId', (req, res) => {
  const s = activeSessions.get(req.params.sessionId);
  if (!s) return res.json({ sessionId: req.params.sessionId, status: 'not_found' });
  return res.json({ sessionId: req.params.sessionId, status: s.status, phoneNumber: s.phoneNumber });
});

app.delete('/api/session/:sessionId', (req, res) => {
  clearSession(req.params.sessionId);
  return res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
  const sessions = [...activeSessions.entries()].map(([id, s]) => ({
    sessionId: id, status: s.status, phoneNumber: s.phoneNumber,
  }));
  return res.json({ sessions });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n⚡ sleek-md Pairer on http://localhost:${PORT}\n`));
