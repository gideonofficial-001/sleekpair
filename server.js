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

const activeSessions = new Map();

function sessionPath(sessionId) {
  return path.join(SESSIONS_FOLDER, sessionId);
}

function clearSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (s?.sock) { try { s.sock.ws?.close(); } catch (_) {} }
  activeSessions.delete(sessionId);
  const folder = sessionPath(sessionId);
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

function encodeSession(sessionId) {
  const folder = sessionPath(sessionId);
  if (!fs.existsSync(folder)) return null;
  const bundle = {};
  for (const file of fs.readdirSync(folder)) {
    try { bundle[file] = fs.readFileSync(path.join(folder, file), 'utf-8'); } catch (_) {}
  }
  return Buffer.from(JSON.stringify(bundle)).toString('base64');
}

async function sendSessionToUser(sock, phoneNumber, sessionId, base64Session) {
  const jid = phoneNumber + '@s.whatsapp.net';
  const msg = [
    `╭──────────────────────────╮`,
    `│  *sleek-md Connected!* ✅  │`,
    `╰──────────────────────────╯`,
    ``,
    `Your bot has been linked successfully.`,
    ``,
    `*Session ID:* \`${sessionId}\``,
    ``,
    `*Session String (keep safe 🔐):*`,
    `\`\`\`${base64Session}\`\`\``,
    ``,
    `⚠️ _Do NOT share this with anyone._`,
    `_It gives full access to your WhatsApp._`,
    ``,
    `— sleek-md by Sleek Tech`,
  ].join('\n');
  await sock.sendMessage(jid, { text: msg });
}

// ── Main pairing function ─────────────────────────────────────────────────────
async function startPairingSession(sessionId, phoneNumber) {
  const sessionDir = sessionPath(sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    mobile: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  activeSessions.set(sessionId, { sock, status: 'waiting', phoneNumber });
  sock.ev.on('creds.update', saveCreds);

  // ── THE FIX: request pairing code RIGHT AWAY if not yet registered ────────
  // Do NOT wait for the QR event. Call this immediately after socket creation.
  // This is what triggers WhatsApp to send the "Link a device" notification.
  let codeSent = false;

  const requestCode = async () => {
    if (codeSent || sock.authState.creds.registered) return null;
    codeSent = true;
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      return code?.match(/.{1,4}/g)?.join('-') ?? code;
    } catch (err) {
      throw new Error('Failed to get pairing code: ' + err.message);
    }
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out. Check your phone number includes the country code.'));
      clearSession(sessionId);
    }, 60_000);

    // ── Attempt code request on first connection.update ───────────────────
    let codeResolved = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, isNewLogin } = update;

      // Request code as soon as the socket starts connecting
      if (!codeResolved && !sock.authState.creds.registered) {
        try {
          const formatted = await requestCode();
          if (formatted && !codeResolved) {
            codeResolved = true;
            clearTimeout(timeout);
            activeSessions.get(sessionId).status = 'code_issued';
            resolve({ formatted });
          }
        } catch (err) {
          if (!codeResolved) {
            codeResolved = true;
            clearTimeout(timeout);
            reject(err);
            clearSession(sessionId);
          }
        }
      }

      if (connection === 'open') {
        const session = activeSessions.get(sessionId);
        if (session) session.status = 'connected';
        console.log(`[${sessionId}] ✅ Linked to WhatsApp`);

        // Send session string after socket stabilises
        setTimeout(async () => {
          try {
            const b64 = encodeSession(sessionId);
            if (b64) {
              await sendSessionToUser(sock, phoneNumber, sessionId, b64);
              console.log(`[${sessionId}] 📤 Session string sent to +${phoneNumber}`);
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

        console.log(`[${sessionId}] Connection closed — code ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          clearSession(sessionId);
        } else {
          const session = activeSessions.get(sessionId);
          if (session) session.status = 'disconnected';

          // If we closed before the code was sent, it's a real error
          if (!codeResolved) {
            codeResolved = true;
            clearTimeout(timeout);
            reject(new Error(`WhatsApp closed the connection (code ${statusCode}). Try again.`));
            clearSession(sessionId);
          }
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
    return res.status(400).json({ error: 'Invalid phone number. Include full country code, digits only.' });
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
    const { formatted } = await startPairingSession(sessionId, cleanNumber);
    return res.json({
      success: true,
      sessionId,
      phoneNumber: cleanNumber,
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
