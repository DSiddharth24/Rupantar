'use strict';

require('dotenv').config();

const express = require('express');

const { setSession, getSession, clearSession, startSweep: startSessionSweep } = require('./services/session');
const { storeFile, consumeFile, startSweep: startEphemeralSweep }             = require('./services/ephemeralStore');
const { convertFile }                                                           = require('./services/convert');
const {
  downloadIncomingMedia,
  sendText,
  sendButtons,
  sendMedia,
  normalisePhone,
  formatPromptText
} = require('./services/messaging');
const { getConversionOptions, isValidConversion, targetFormatFromButtonId } = require('./lib/conversionMatrix');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT            || 3001;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// Memory safety: reject files larger than 15 MB (WhatsApp's own limit is ~16 MB)
const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Memory safety: cap total concurrent in-flight upload sessions
const MAX_CONCURRENT_SESSIONS = 50;

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded bodies
app.use(express.json());

// ─── Background sweeps ───────────────────────────────────────────────────────

startSessionSweep();
startEphemeralSweep();

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Rupantar' });
});

// ─── Ephemeral file endpoint ─────────────────────────────────────────────────

/**
 * GET /file/:token
 *
 * One-time file serving for outbound converted files.
 * Twilio fetches this URL to attach the file to the WhatsApp message.
 * The buffer is deleted immediately after the first successful read.
 */
app.get('/file/:token', (req, res) => {
  const { token } = req.params;

  // consumeFile deletes the entry atomically — safe against double-fetch
  const file = consumeFile(token);

  if (!file) {
    return res.status(404).json({ error: 'File not found or already retrieved.' });
  }

  res.set('Content-Type', file.mimeType);
  res.set('Content-Disposition', `attachment; filename="${sanitiseFilename(file.filename)}"`);
  res.set('Content-Length', file.buffer.length);
  // Prevent any caching — this URL is one-time only
  res.set('Cache-Control', 'no-store');
  return res.send(file.buffer);
});

// ─── WhatsApp webhook ─────────────────────────────────────────────────────────

/**
 * POST /webhook/whatsapp
 *
 * Twilio calls this for every inbound WhatsApp message.
 * Body is application/x-www-form-urlencoded.
 *
 * Key fields:
 *   From          — sender's WhatsApp number, e.g. 'whatsapp:+919876543210'
 *   NumMedia      — count of attached media files
 *   MediaUrl0     — URL of the first media file (Twilio CDN)
 *   MediaContentType0 — MIME type Twilio detected (we re-detect via magic bytes)
 *   ButtonPayload — set when user taps a quick-reply button (Twilio's field name)
 *   ButtonText    — display text of the tapped button
 *
 * For Content API quick-replies, Twilio forwards:
 *   ButtonPayload containing the `id` we set (e.g. 'convert_pdf')
 */
app.post('/webhook/whatsapp', async (req, res) => {
  // Twilio expects a 200 with an empty TwiML body (or valid TwiML) promptly.
  // We reply immediately and do the heavy lifting asynchronously so we don't
  // time out Twilio's webhook delivery window.
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const body = req.body;

  // Log the full incoming payload so we can see exactly what Twilio is sending
  console.log('[webhook] Incoming payload:', JSON.stringify(body, null, 2));

  const from = normalisePhone(body.From);

  if (!from) {
    console.warn('[webhook] Received request with no From field — ignoring.');
    return;
  }

  try {
    const numMedia      = parseInt(body.NumMedia || '0', 10);
    const buttonPayload = body.ButtonPayload; // set on quick-reply tap

    console.log(`[webhook] From=${from} NumMedia=${numMedia} ButtonPayload=${buttonPayload || 'none'}`);

    if (buttonPayload) {
      // ── Branch: user tapped a format-choice button ──────────────────────
      await handleButtonReply(from, buttonPayload.trim());
    } else if (numMedia > 0) {
      // ── Branch: user sent a file ─────────────────────────────────────────
      await handleIncomingMedia(from, body.MediaUrl0, body.MediaContentType0);
    } else if (body.Body) {
      // ── Branch: plain text ───────────────────────────────────────────────
      // Check if this looks like a fallback number reply (e.g. "1", "2", "3")
      // used when the Content API buttons couldn't be sent.
      const text = body.Body.trim();
      const session = require('./services/session').getSession(from);
      if (session && /^[1-9]$/.test(text)) {
        const options = getConversionOptions(session.detectedType);
        const idx = parseInt(text, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          await handleButtonReply(from, options[idx].id);
        } else {
          await sendText(from, `Please reply with a number between 1 and ${options.length}.`);
        }
      } else {
        // Generic onboarding prompt
        await sendText(
          from,
          "Hi, I'm Rupantar 👋 — send me a Word, Excel, PowerPoint, or PDF file and I'll convert it for you."
        );
      }
    } else {
      // No media, no text, no button — ignore silently
    }
  } catch (err) {
    console.error(`[webhook] Unhandled error for ${from}:`, err.message);
    // Best-effort error reply to the user
    sendText(from, 'Something went wrong on my end — please try again.').catch(() => {});
  }
});

// ─── Handler: incoming media ──────────────────────────────────────────────────

async function handleIncomingMedia(from, mediaUrl, _twilioMimeHint) {
  console.log(`[handleIncomingMedia] from=${from} mediaUrl=${mediaUrl}`);
  if (!mediaUrl) {
    await sendText(from, "I couldn't retrieve your file. Please try sending it again.");
    return;
  }

  // Memory-safety gate: check session count before accepting a new upload
  const { _size } = require('./services/session');
  if (_size() >= MAX_CONCURRENT_SESSIONS) {
    await sendText(from, "Rupantar is a bit busy right now — please try again in a moment.");
    return;
  }

  // 1. Download file from Twilio CDN into memory
  let buffer;
  try {
    buffer = await downloadIncomingMedia(mediaUrl);
  } catch (err) {
    console.error('[handleIncomingMedia] Download failed:', err.message);
    await sendText(from, "I couldn't download your file. Please try again.");
    return;
  }

  // 2. Size gate — before we do anything else with the buffer
  if (buffer.length > MAX_FILE_BYTES) {
    buffer = null; // release immediately
    await sendText(from, `That file is over 15 MB — please send a smaller file.`);
    return;
  }

  // 3. Detect real file type via magic bytes (never trust MIME headers)
  const detectedType = await detectFileType(buffer);
  console.log(`[handleIncomingMedia] detectedType=${detectedType} bufferSize=${buffer.length}`);
  if (!detectedType) {
    buffer = null;
    await sendText(
      from,
      "I can only convert Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and PDF files. " +
      "Please send one of those."
    );
    return;
  }

  // 4. Check we have at least one conversion option for this type
  const options = getConversionOptions(detectedType);
  if (options.length === 0) {
    buffer = null;
    await sendText(from, `I don't have any conversion options for that file type yet.`);
    return;
  }

  // 5. Store session (buffer lives in RAM here, key = phone number)
  setSession(from, buffer, detectedType);

  // 6. Reply with interactive format-choice buttons
  const promptText = formatPromptText(detectedType);
  console.log(`[handleIncomingMedia] sending buttons to ${from}: ${promptText}`);
  try {
    await sendButtons(from, promptText, options, detectedType);
    console.log(`[handleIncomingMedia] buttons sent OK to ${from}`);
  } catch (err) {
    console.error(`[handleIncomingMedia] sendButtons failed:`, err.message, err.stack);
    await sendText(from, `Got it — reply with the number of your desired format:\n${options.map((o,i)=>`${i+1}. ${o.title}`).join('\n')}`);
  }
}

// ─── Handler: button tap ──────────────────────────────────────────────────────

async function handleButtonReply(from, buttonId) {
  // 1. Retrieve pending session
  const session = getSession(from);
  if (!session) {
    await sendText(
      from,
      "That option has expired — please resend your file and I'll give you fresh options."
    );
    return;
  }

  // 2. Validate the button id against this session's source type
  if (!isValidConversion(session.detectedType, buttonId)) {
    await sendText(
      from,
      "That's not a valid option for this file — please resend it."
    );
    return;
  }

  const targetFormat = targetFormatFromButtonId(buttonId); // e.g. 'pdf'

  // 3. Convert — buffer in, buffer out, entirely in RAM
  let convertedBuffer, mimeType, ext;
  try {
    const result = await convertFile(session.buffer, session.detectedType, targetFormat);
    convertedBuffer = result.buffer;
    mimeType        = result.mimeType;
    ext             = result.ext;
  } catch (err) {
    console.error('[handleButtonReply] Conversion failed:', err.message);
    await sendText(
      from,
      "Conversion failed — the file may be corrupted or password-protected. Please try another file."
    );
    // Session stays alive so user can try a different format choice
    return;
  }

  // 4. Clear the source session as early as possible — frees the original buffer
  clearSession(from);

  // 5. Store converted buffer in ephemeral map, get one-time token
  const filename = `converted.${ext}`;
  const token    = storeFile(convertedBuffer, mimeType, filename);
  convertedBuffer = null; // hand off ownership to the store; release local ref

  // 6. Build the public URL for this token
  if (!PUBLIC_BASE_URL) {
    console.error('[handleButtonReply] PUBLIC_BASE_URL is not set — cannot serve file.');
    await sendText(from, 'Server misconfiguration — please contact support.');
    return;
  }
  const fileUrl = `${PUBLIC_BASE_URL}/file/${token}`;

  // 7. Send the file to the user
  await sendMedia(from, fileUrl, `Here's your converted file ✅ — Rupantar`);
}

// ─── Utility: magic-byte file type detection ─────────────────────────────────

/**
 * Detect file type from buffer magic bytes using the `file-type` package.
 * file-type v19 is ESM-only, so we use a dynamic import.
 *
 * Returns one of: 'docx' | 'xlsx' | 'pptx' | 'pdf' | null
 *
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
async function detectFileType(buffer) {
  const { fileTypeFromBuffer } = await import('file-type');
  const result = await fileTypeFromBuffer(buffer);

  if (!result) return null;

  const { mime } = result;

  // OOXML formats (docx/xlsx/pptx) all share the ZIP magic bytes, so
  // file-type distinguishes them by their internal structure.
  const mimeMap = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':   'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':         'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/pdf': 'pdf'
  };

  return mimeMap[mime] || null;
}

// ─── Utility: sanitise filename for Content-Disposition ──────────────────────

function sanitiseFilename(name) {
  // Strip characters that are problematic in Content-Disposition header values
  return name.replace(/[^\w.\-]/g, '_');
}

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Rupantar listening on port ${PORT}`);
  if (!PUBLIC_BASE_URL) {
    console.warn('WARNING: PUBLIC_BASE_URL is not set. File delivery will fail.');
  }
});

module.exports = app; // exported for testing
