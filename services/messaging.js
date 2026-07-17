'use strict';

/**
 * services/messaging.js
 *
 * Provider-agnostic messaging interface — Twilio WhatsApp implementation.
 *
 * sendButtons() uses a plain-text numbered menu instead of the Twilio
 * Content API, which is not available on sandbox accounts and requires
 * pre-approved templates in production. The numbered menu works on every
 * Twilio account with zero setup.
 *
 * When the user replies with a number (1, 2, 3…), server.js maps it back
 * to the correct button id via the session's conversion options.
 *
 * To migrate to Meta Cloud API directly:
 *   1. Create services/messaging-meta.js with the same exported signatures.
 *   2. Change the require() in server.js to point at the new file.
 */

const twilio = require('twilio');
const axios  = require('axios');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;

let client;
function getClient() {
  if (!client) {
    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    client = twilio(accountSid, authToken);
  }
  return client;
}

const FRIENDLY_NAMES = {
  docx: 'Word document',
  xlsx: 'Excel file',
  pptx: 'PowerPoint presentation',
  pdf:  'PDF'
};

// ─── Download incoming media ──────────────────────────────────────────────────

async function downloadIncomingMedia(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    auth:         { username: accountSid, password: authToken },
    responseType: 'arraybuffer',
    timeout:      60 * 1000
  });
  return Buffer.from(response.data);
}

// ─── Send plain text ──────────────────────────────────────────────────────────

async function sendText(to, body) {
  await getClient().messages.create({ from: fromNumber, to, body });
}

// ─── Send format-choice menu (plain-text numbered list) ───────────────────────

/**
 * Sends a numbered text menu so the user can reply "1", "2", etc.
 * Works on Twilio sandbox and production with no template approval needed.
 *
 * Example output:
 *   Got it — this is an Excel file. What would you like to convert it to?
 *
 *   1. PDF
 *   2. CSV
 *
 *   Reply with a number to convert.
 *
 * @param {string} to
 * @param {string} bodyText
 * @param {{ id: string, title: string }[]} buttons
 */
async function sendButtons(to, bodyText, buttons) {
  const lines = buttons.map((btn, i) => `${i + 1}. ${btn.title}`);
  const message = [
    bodyText,
    '',
    ...lines,
    '',
    'Reply with a number to convert.'
  ].join('\n');

  await getClient().messages.create({ from: fromNumber, to, body: message });
}

// ─── Send media ───────────────────────────────────────────────────────────────

async function sendMedia(to, mediaUrl, caption) {
  await getClient().messages.create({
    from:     fromNumber,
    to,
    mediaUrl: [mediaUrl],
    body:     caption || ''
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  if (!raw) return raw;
  const stripped = raw.replace(/^whatsapp:/i, '');
  return `whatsapp:${stripped}`;
}

function formatPromptText(detectedType) {
  const name = FRIENDLY_NAMES[detectedType] || detectedType;
  return `Got it — this is a ${name}. What would you like to convert it to?`;
}

module.exports = {
  downloadIncomingMedia,
  sendText,
  sendButtons,
  sendMedia,
  normalisePhone,
  formatPromptText,
  FRIENDLY_NAMES
};
