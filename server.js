'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const pino     = require('pino');
const { Boom } = require('@hapi/boom');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const app    = express();
const PORT   = process.env.PORT || 3000;
const SESS   = path.join(__dirname, 'sessions');
const logger = pino({ level: 'silent' });

if (!fs.existsSync(SESS)) fs.mkdirSync(SESS, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sessionId → { sock, status, phoneNumber }
const registry = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const sessDir  = (id) => path.join(SESS, id);

function wipeDir(id) {
  const d = sessDir(id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

function killSocket(id) {
  const entry = registry.get(id);
  if (!entry) return;
  try { entry.sock?.ws?.close(); }   catch (_) {}
  try { entry.sock?.end(undefined); } catch (_) {}
}

function destroy(id) {
  killSocket(id);
  registry.delete(id);
  wipeDir(id);
}

function encodeSession(id) {
  const dir = sessDir(id);
  if (!fs.existsSync(dir)) return null;

  const bundle = {};
  for (const f of fs.readdirSync(dir)) {
    try { bundle[f] = fs.readFileSync(path.join(dir, f), 'utf-8'); }
    catch (_) {}
  }
  if (!Object.keys(bundle).length) return null;
  return Buffer.from(JSON.stringify(bundle)).toString('base64');
}

async function deliverSession(sock, phone, id, b64) {
  const jid = phone + '@s.whatsapp.net';
  const text = [
    `╭──────────────────────────╮`,
    `│  *sleek-md Connected* ✅   │`,
    `╰──────────────────────────╯`,
    ``,
    `Your bot is now linked to WhatsApp.`,
    ``,
    `*Session ID:*`,
    `\`${id}\``,
    ``,
    `*Session String (back this up 🔐):*`,
    `\`\`\`${b64}\`\`\``,
    ``,
    `⚠️ _Keep this private — it is your account key._`,
    ``,
    `— *sleek-md* by Sleek Tech`,
  ].join('\n');

  await sock.sendMessage(jid, { text });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: start a pairing session and return a code
// ─────────────────────────────────────────────────────────────────────────────

function startPairing(sessionId, phoneNumber) {
  return new Promise(async (resolve, reject) => {

    // ── 1. Fresh slate every time ──────────────────────────────────────────
    wipeDir(sessionId);
    fs.mkdirSync(sessDir(sessionId), { recursive: true });

    // ── 2. Load (empty) auth state ─────────────────────────────────────────
    const { state, saveCreds } = await useMultiFileAuthState(sessDir(sessionId));

    // ── 3. Create socket ───────────────────────────────────────────────────
    //
    //  IMPORTANT NOTES:
    //  • Do NOT use fetchLatestBaileysVersion() — it makes an HTTP request
    //    to WhatsApp that can fail on Render and produce a wrong version,
    //    which causes an immediate close.
    //  • Browsers.macOS('Safari') is the most accepted fingerprint right now.
    //  • defaultQueryTimeoutMs: undefined prevents premature query timeouts.
    //
    const sock = makeWASocket({
      auth:                    state,
      logger,
      printQRInTerminal:       false,
      browser:                 Browsers.macOS('Safari'),
      defaultQueryTimeoutMs:   undefined,
      connectTimeoutMs:        60_000,
      keepAliveIntervalMs:     10_000,
      syncFullHistory:         false,
      markOnlineOnConnect:     false,
      generateHighQualityLinkPreview: false,
    });

    registry.set(sessionId, { sock, status: 'waiting', phoneNumber });
    sock.ev.on('creds.update', saveCreds);

    // ── 4. Guard: hard timeout ─────────────────────────────────────────────
    let settled = false;

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (err) { destroy(sessionId); reject(err); }
      else resolve(code);
    };

    const guard = setTimeout(() => {
      finish(new Error(
        'Timed out (60 s). WhatsApp never sent a QR signal. ' +
        'This usually means the Render IP is rate-limited — wait a few minutes and try again.'
      ));
    }, 60_000);

    // ── 5. Listen for connection events ────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // ── QR signal → this is our cue to request a pairing code ───────────
      //
      //  When Baileys emits a QR it means the WebSocket handshake with
      //  WhatsApp is complete and the session is ready to be authenticated.
      //  We intercept it and call requestPairingCode() instead of showing
      //  the QR. This is the officially supported path.
      //
      if (qr) {
        console.log(`[${sessionId}] QR ready — requesting pairing code…`);
        try {
          const raw       = await sock.requestPairingCode(phoneNumber);
          const formatted = raw?.match(/.{1,4}/g)?.join('-') ?? raw;

          const entry = registry.get(sessionId);
          if (entry) entry.status = 'code_issued';

          console.log(`[${sessionId}] Code: ${formatted}`);
          finish(null, formatted);

        } catch (err) {
          console.error(`[${sessionId}] requestPairingCode error:`, err.message);
          finish(new Error('WhatsApp refused the pairing code request: ' + err.message));
        }
        return;
      }

      // ── Fully linked ─────────────────────────────────────────────────────
      if (connection === 'open') {
        const entry = registry.get(sessionId);
        if (entry) entry.status = 'connected';
        console.log(`[${sessionId}] ✅ Linked to WhatsApp`);

        // Give the socket 3 s to settle before sending a message
        setTimeout(async () => {
          try {
            const b64 = encodeSession(sessionId);
            if (b64) {
              await deliverSession(sock, phoneNumber, sessionId, b64);
              console.log(`[${sessionId}] 📨 Session string delivered`);
            }
          } catch (e) {
            console.error(`[${sessionId}] Could not deliver session string:`, e.message);
          }
        }, 3000);
      }

      // ── Disconnected ─────────────────────────────────────────────────────
      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : 0;

        console.log(`[${sessionId}] Closed — WA status code: ${code}`);

        // Logged out → wipe and stop
        if (code === DisconnectReason.loggedOut) {
          destroy(sessionId);
          return;
        }

        // Update registry status
        const entry = registry.get(sessionId);
        if (entry) entry.status = 'disconnected';

        // If we closed BEFORE the code was issued, surface a readable error
        if (!settled) {
          const msg =
            code === 401 ? 'WhatsApp rejected the auth (401 Unauthorized). Clear sessions and try again.' :
            code === 403 ? 'Access forbidden (403). Your number may be temporarily restricted by WhatsApp.' :
            code === 408 ? 'Connection timed out (408). Try again in a minute.' :
            code === 428 ? 'Connection not established (428). Render may be rate-limited — wait and retry.' :
            code === 440 ? 'Logged out by another session (440). Try again.' :
            code === 500 ? 'WhatsApp internal error (500). Try again shortly.' :
                           `Connection closed (code ${code}) before a code could be issued. Try again.`;

          finish(new Error(msg));
        }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/request-code
 * { phoneNumber: "2547XXXXXXXX", sessionId?: "my-bot" }
 */
app.post('/api/request-code', async (req, res) => {
  let { phoneNumber, sessionId } = req.body ?? {};

  if (!phoneNumber)
    return res.status(400).json({ error: 'phoneNumber is required.' });

  const phone = phoneNumber.replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ error: 'Invalid phone number. Use full number with country code, digits only. Example: 2547XXXXXXXX' });

  sessionId = (sessionId?.trim() || `sleek_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');

  // Block duplicate in-progress pairings
  if (registry.has(sessionId)) {
    const { status } = registry.get(sessionId);
    if (status === 'waiting' || status === 'code_issued')
      return res.status(409).json({ error: 'Pairing already in progress. Wait or use a different session ID.' });
    destroy(sessionId);
  }

  try {
    const formatted = await startPairing(sessionId, phone);
    return res.json({
      success:          true,
      sessionId,
      phoneNumber:      phone,
      formatted,
      expiresInSeconds: 160,
    });
  } catch (err) {
    console.error(`[${sessionId}] Fatal:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** GET /api/status/:id */
app.get('/api/status/:id', (req, res) => {
  const e = registry.get(req.params.id);
  if (!e) return res.json({ sessionId: req.params.id, status: 'not_found' });
  return res.json({ sessionId: req.params.id, status: e.status, phoneNumber: e.phoneNumber });
});

/** DELETE /api/session/:id */
app.delete('/api/session/:id', (req, res) => {
  destroy(req.params.id);
  res.json({ success: true });
});

/** GET /api/sessions */
app.get('/api/sessions', (_req, res) => {
  const sessions = [...registry.entries()].map(([id, e]) => ({
    sessionId: id, status: e.status, phoneNumber: e.phoneNumber,
  }));
  res.json({ sessions });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡ sleek-md Pairer  →  http://localhost:${PORT}\n`);
});
