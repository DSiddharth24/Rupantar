'use strict';

/**
 * services/messaging.js
 *
 * Provider-agnostic messaging interface.
 * Current implementation: Twilio WhatsApp API.
 *
 * To migrate to Meta Cloud API directly:
 *   1. Create services/messaging-meta.js with the same exported function signatures.
 *   2. Swap the require() in server.js from './services/messaging' to
 *      './services/messaging-meta'.
 *   3. Nothing else in the app references Twilio directly.
 *
 * Exported functions:
 *   downloadIncomingMedia(mediaUrl)                       → Buffer
 *   sendText(to, body)                                    → void
 *   sendButtons(to, bodyText, buttons)                    → void
 *   sendMedia(to, mediaUrl, caption)                      → void
 *
 * WhatsApp Interactive Reply Buttons format (Twilio):
 *   Twilio uses its own proprietary JSON field (`PersistentAction` etc.) for
 *   interactive messages — it does NOT expose the raw Meta interactive JSON
 *   directly in the REST API. Instead, Twilio renders buttons via the
 *   `contentSid` approach (Twilio Content API) or via the `Body` + actions
 *   in the Conversations API.
 *
 *   For the sandbox / prototype phase we use the Twilio Content API to
 *   create a one-time quick-reply template and send it via messages.create().
 *   For the interactive button payload (button_reply callback) we parse the
 *   incoming webhook's `ButtonText` or `ListReply` fields that Twilio forwards.
 *
 *   Practically: we build the interactive message body using the Twilio
 *   ContentSid approach — see sendButtons() below for the full explanation.
 */

const twilio = require('twilio');
const axios  = require('axios');

const accountSid      = process.env.TWILIO_ACCOUNT_SID;
const authToken       = process.env.TWILIO_AUTH_TOKEN;
const fromNumber      = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. 'whatsapp:+14155238886'

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

// ─── Friendly display names ───────────────────────────────────────────────────

const FRIENDLY_NAMES = {
  docx: 'Word document',
  xlsx: 'Excel file',
  pptx: 'PowerPoint presentation',
  pdf:  'PDF'
};

// ─── Download incoming media ─────────────────────────────────────────────────

/**
 * Download a media file from Twilio's CDN into a Buffer.
 * Uses HTTP Basic Auth (accountSid:authToken) as required by Twilio.
 *
 * @param {string} mediaUrl — the MediaUrl0 value from the webhook body
 * @returns {Promise<Buffer>}
 */
async function downloadIncomingMedia(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    auth: { username: accountSid, password: authToken },
    responseType: 'arraybuffer',
    timeout: 60 * 1000 // 60 s — large files
  });
  return Buffer.from(response.data);
}

// ─── Send plain text ─────────────────────────────────────────────────────────

/**
 * Send a plain-text WhatsApp message.
 *
 * @param {string} to   — E.164 with whatsapp: prefix, e.g. 'whatsapp:+919876543210'
 * @param {string} body
 */
async function sendText(to, body) {
  await getClient().messages.create({ from: fromNumber, to, body });
}

// ─── Send interactive buttons ────────────────────────────────────────────────

/**
 * Send a WhatsApp Interactive Reply Buttons message via the Twilio Content API.
 *
 * Twilio's WhatsApp channel supports Meta's interactive messages through the
 * Content API (https://www.twilio.com/docs/content/whatsapp-content-types).
 * We create a transient Content template on-the-fly for each message,
 * then immediately send it. This avoids having to pre-register templates.
 *
 * NOTE for post-prototype Meta Cloud API migration:
 *   Replace this entire function with a direct POST to
 *   https://graph.facebook.com/v19.0/{phone-number-id}/messages
 *   using the standard interactive → button JSON payload — no Content API needed.
 *
 * @param {string} to
 * @param {string} bodyText                          — message body
 * @param {{ id: string, title: string }[]} buttons  — max 3 items
 * @param {string} [detectedType]                    — used to build a friendly header
 */
async function sendButtons(to, bodyText, buttons, detectedType) {
  if (buttons.length > 3) {
    throw new Error(
      `WhatsApp Reply Buttons are capped at 3. Got ${buttons.length} for type "${detectedType}". ` +
      'Switch this type to a List Message.'
    );
  }

  const c = getClient();

  // Build the Twilio Content API quick-reply payload
  const quickReplies = buttons.map(btn => ({ id: btn.id, title: btn.title }));

  // Create a Content resource (lives briefly — we send immediately then don't reuse)
  const content = await c.content.v1.contents.create({
    friendlyName: `rupantar-${Date.now()}`,
    language:     'en',
    variables:    { '1': bodyText },
    types: {
      'twilio/quick-reply': {
        body:    bodyText,
        actions: quickReplies.map(qr => ({
          title: qr.title,
          id:    qr.id,
          type:  'QUICK_REPLY'
        }))
      }
    }
  });

  await c.messages.create({
    from:       fromNumber,
    to,
    contentSid: content.sid
  });
}

// ─── Send media (outbound converted file) ────────────────────────────────────

/**
 * Send a file attachment via WhatsApp.
 * Twilio fetches the file from mediaUrl — this must be a publicly reachable URL.
 * We provide this via our ephemeral /file/:token endpoint (never a storage bucket).
 *
 * @param {string} to
 * @param {string} mediaUrl  — public URL to the converted file (ephemeral endpoint)
 * @param {string} [caption] — optional caption text
 */
async function sendMedia(to, mediaUrl, caption) {
  await getClient().messages.create({
    from:     fromNumber,
    to,
    mediaUrl: [mediaUrl],
    body:     caption || ''
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise an incoming phone number to the 'whatsapp:+...' format.
 * Twilio sends 'From' already in this format, but this guards against
 * any future provider that might not.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalisePhone(raw) {
  if (!raw) return raw;
  const stripped = raw.replace(/^whatsapp:/i, '');
  return `whatsapp:${stripped}`;
}

/**
 * Build the body text for the format-choice prompt.
 *
 * @param {string} detectedType
 * @returns {string}
 */
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
