'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

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
} = require('./services/messaging-meta');
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

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  // Respond immediately to Meta
  res.sendStatus(200);

  const body = req.body;
  console.log('[webhook] Incoming payload:', JSON.stringify(body, null, 2));

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message) return;

  const from = normalisePhone(message.from);

  try {
    console.log(`[webhook] From=${from} Type=${message.type}`);

    if (message.type === 'document' || message.type === 'image') {
      // ── User sent a file ────────────────────────────────────────────────
      const media = message.document || message.image;
      await handleIncomingMedia(from, media.id, media.mime_type, media.filename);
    } else if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
      // ── User tapped a button ────────────────────────────────────────────
      const buttonReplyId = message.interactive.button_reply.id;
      await handleButtonReply(from, buttonReplyId);
    } else if (message.type === 'text') {
      // ── User sent text ──────────────────────────────────────────────────
      await sendText(
        from,
        "Hi, I'm Rupantar 👋 — send me a Word, Excel, PowerPoint, or PDF file and I'll convert it for you."
      );
    }
  } catch (err) {
    console.error(`[webhook] Unhandled error for ${from}:`, err.message);
    sendText(from, 'Something went wrong on my end — please try again.').catch(() => {});
  }
});

// ─── Handler: incoming media ──────────────────────────────────────────────────

async function handleIncomingMedia(from, mediaId, _mimeHint, originalFilename) {
  console.log(`[handleIncomingMedia] from=${from} mediaId=${mediaId}`);
  if (!mediaId) {
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
    buffer = await downloadIncomingMedia(mediaId);
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
  setSession(from, buffer, detectedType, originalFilename || `upload.${detectedType}`);

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
  console.log(`[handleButtonReply] from=${from} buttonId=${buttonId}`);
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
  const filename = buildOutputFilename(session.originalFilename, ext);
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
