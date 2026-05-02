const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const SESSIONS_FOLDER = path.join(__dirname, 'sessions');

// Ensure sessions folder exists
if (!fs.existsSync(SESSIONS_FOLDER)) fs.mkdirSync(SESSIONS_FOLDER, { recursive: true });

// ─── In-memory session registry ───────────────────────────────────────────────
const activeSessions = new Map(); // sessionId → { sock, status, phoneNumber }

function sessionPath(sessionId) {
  return path.join(SESSIONS_FOLDER, sessionId);
}

function clearSession(sessionId) {
  const folder = sessionPath(sessionId);
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
  activeSessions.delete(sessionId);
}

// ─── Request pairing code ──────────────────────────────────────────────────────
async function requestPairingCode(sessionId, phoneNumber) {
  const sessionDir = sessionPath(sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });

  // Store in registry
  activeSessions.set(sessionId, {
    sock,
    status: 'waiting',
    phoneNumber,
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for QR / pairing code event.'));
      sock.end();
      clearSession(sessionId);
    }, 45_000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // When WhatsApp sends a QR event, intercept and request pairing code instead
      if (qr) {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          clearTimeout(timeout);

          const formatted = code.match(/.{1,4}/g)?.join('-') ?? code;
          activeSessions.get(sessionId).status = 'code_issued';
          resolve({ code, formatted });
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
          sock.end();
          clearSession(sessionId);
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(timeout);
        activeSessions.get(sessionId).status = 'connected';
        console.log(`[${sessionId}] ✅ WhatsApp connected!`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : 0;

        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.log(`[${sessionId}] Logged out. Clearing session.`);
          clearSession(sessionId);
        } else {
          activeSessions.get(sessionId).status = 'disconnected';
        }
      }
    });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/request-code
 * Body: { phoneNumber: "1234567890", sessionId?: "my-bot" }
 */
app.post('/api/request-code', async (req, res) => {
  let { phoneNumber, sessionId } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required.' });
  }

  // Strip everything except digits
  const cleanNumber = phoneNumber.replace(/\D/g, '');

  if (cleanNumber.length < 7 || cleanNumber.length > 15) {
    return res.status(400).json({ error: 'Invalid phone number length. Use E.164 format without the + sign.' });
  }

  // Auto-generate a session ID if none provided
  sessionId = (sessionId || `session_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');

  // Prevent duplicate requests on the same session
  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.status === 'waiting') {
      return res.status(409).json({ error: 'A pairing request is already in progress for this session.' });
    }
    // Clear stale session so we can re-pair
    clearSession(sessionId);
  }

  try {
    const { code, formatted } = await requestPairingCode(sessionId, cleanNumber);
    return res.json({
      success: true,
      sessionId,
      phoneNumber: cleanNumber,
      code,
      formatted,
      expiresInSeconds: 160,
    });
  } catch (err) {
    console.error(`[${sessionId}] Error:`, err.message);
    clearSession(sessionId);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/status/:sessionId
 */
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.json({ sessionId, status: 'not_found' });
  }
  return res.json({ sessionId, status: session.status, phoneNumber: session.phoneNumber });
});

/**
 * DELETE /api/session/:sessionId
 */
app.delete('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (session?.sock) {
    try { session.sock.end(); } catch (_) {}
  }
  clearSession(sessionId);
  return res.json({ success: true, message: `Session ${sessionId} cleared.` });
});

/**
 * GET /api/sessions
 */
app.get('/api/sessions', (req, res) => {
  const sessions = [...activeSessions.entries()].map(([id, s]) => ({
    sessionId: id,
    status: s.status,
    phoneNumber: s.phoneNumber,
  }));
  return res.json({ sessions });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 WhatsApp Pair Generator running on http://localhost:${PORT}\n`);
});
