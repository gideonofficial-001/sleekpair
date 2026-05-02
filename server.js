const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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

// ── Active session registry ────────────────────────────────────────────────────
const activeSessions = new Map();

function sessionPath(sessionId) {
  return path.join(SESSIONS_FOLDER, sessionId);
}

function clearSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (s?.sock) { try { s.sock.end(); } catch (_) {} }
  activeSessions.delete(sessionId);
  const folder = sessionPath(sessionId);
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

// ── Encode entire session folder → base64 JSON blob ───────────────────────────
function encodeSession(sessionId) {
  const folder = sessionPath(sessionId);
  if (!fs.existsSync(folder)) return null;
  const bundle = {};
  for (const file of fs.readdirSync(folder)) {
    try {
      bundle[file] = fs.readFileSync(path.join(folder, file), 'utf-8');
    } catch (_) {}
  }
  return Buffer.from(JSON.stringify(bundle)).toString('base64');
}

// ── Send session string to user's WhatsApp ─────────────────────────────────────
async function sendSessionToUser(sock, phoneNumber, sessionId, base64Session) {
  const jid = phoneNumber + '@s.whatsapp.net';
  const message = [
    `╭─────────────────────────╮`,
    `│   *sleek-md Connected!* ✅  │`,
    `╰─────────────────────────╯`,
    ``,
    `Your bot has been linked successfully.`,
    ``,
    `*Session ID:* \`${sessionId}\``,
    ``,
    `*Session String (keep this safe 🔐):*`,
    `\`\`\`${base64Session}\`\`\``,
    ``,
    `⚠️ _Do NOT share this with anyone._`,
    `_It gives full access to your WhatsApp._`,
    ``,
    `— sleek-md by Sleek Tech`,
  ].join('\n');
  await sock.sendMessage(jid, { text: message });
}

// ── Core pairing function ─────────────────────────────────────────────────────
async function startPairingSession(sessionId, phoneNumber) {
  const sessionDir = sessionPath(sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),

    // Critical: desktop Chrome fingerprint — shows as "Chrome (Desktop)"
    // in WhatsApp Linked Devices and is accepted by WhatsApp's pairing flow
    browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.82'],

    mobile: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  activeSessions.set(sessionId, { sock, status: 'waiting', phoneNumber });
  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out — WhatsApp did not respond within 45 seconds.'));
      clearSession(sessionId);
    }, 45_000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // Intercept QR → request pairing code instead
      if (qr) {
        try {
          // Small delay helps WhatsApp accept the code request reliably
          await new Promise(r => setTimeout(r, 1500));
          const code = await sock.requestPairingCode(phoneNumber);
          clearTimeout(timeout);
          const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
          activeSessions.get(sessionId).status = 'code_issued';
          resolve({ code, formatted });
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
          clearSession(sessionId);
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(timeout);
        const session = activeSessions.get(sessionId);
        if (session) session.status = 'connected';
        console.log(`[${sessionId}] Connected to WhatsApp`);

        // Wait for socket to stabilise then send session string
        setTimeout(async () => {
          try {
            const base64Session = encodeSession(sessionId);
            if (base64Session) {
              await sendSessionToUser(sock, phoneNumber, sessionId, base64Session);
              console.log(`[${sessionId}] Session string sent to +${phoneNumber}`);
            }
          } catch (err) {
            console.error(`[${sessionId}] Could not send session string:`, err.message);
          }
        }, 3000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : 0;

        if (statusCode === DisconnectReason.loggedOut) {
          clearSession(sessionId);
        } else {
          const session = activeSessions.get(sessionId);
          if (session) session.status = 'disconnected';
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
    return res.status(400).json({ error: 'Invalid phone number. Include country code, digits only.' });
  }

  sessionId = (sessionId || `sleek_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');

  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.status === 'waiting' || existing.status === 'code_issued') {
      return res.status(409).json({ error: 'Pairing already in progress for this session.' });
    }
    clearSession(sessionId);
  }

  try {
    const { code, formatted } = await startPairingSession(sessionId, cleanNumber);
    return res.json({
      success: true,
      sessionId,
      phoneNumber: cleanNumber,
      code,
      formatted,
      expiresInSeconds: 160,
      note: 'After linking, your session string will be sent to your WhatsApp inbox.',
    });
  } catch (err) {
    console.error(`[${sessionId}] Error:`, err.message);
    clearSession(sessionId);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) return res.json({ sessionId: req.params.sessionId, status: 'not_found' });
  return res.json({ sessionId: req.params.sessionId, status: session.status, phoneNumber: session.phoneNumber });
});

app.delete('/api/session/:sessionId', (req, res) => {
  clearSession(req.params.sessionId);
  return res.json({ success: true, message: `Session ${req.params.sessionId} cleared.` });
});

app.get('/api/sessions', (req, res) => {
  const sessions = [...activeSessions.entries()].map(([id, s]) => ({
    sessionId: id, status: s.status, phoneNumber: s.phoneNumber,
  }));
  return res.json({ sessions });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n⚡ sleek-md Pairer running on http://localhost:${PORT}\n`));
