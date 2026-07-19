'use strict';

/**
 * services/messaging-meta.js
 *
 * Provider-agnostic messaging interface — Meta WhatsApp Cloud API implementation.
 */

const axios = require('axios');

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

const FRIENDLY_NAMES = {
  docx: 'Word document',
  xlsx: 'Excel file',
  pptx: 'PowerPoint presentation',
  pdf:  'PDF'
};

async function getClient() {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('META_ACCESS_TOKEN and META_PHONE_NUMBER_ID must be set');
  }
  return axios.create({
    baseURL: `https://graph.facebook.com/v18.0`,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`
    }
  });
}

// ─── Download incoming media ──────────────────────────────────────────────────

async function downloadIncomingMedia(mediaId) {
  const client = await getClient();
  
  // Step 1: get URL
  const urlResponse = await client.get(`/${mediaId}`);
  const mediaUrl = urlResponse.data.url;

  // Step 2: download bytes
  const response = await client.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 60 * 1000
  });
  
  return Buffer.from(response.data);
}

// ─── Send plain text ──────────────────────────────────────────────────────────

async function sendText(to, body) {
  const client = await getClient();
  await client.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  });
}

// ─── Send format-choice menu (interactive buttons) ────────────────────────────

async function sendButtons(to, bodyText, buttons) {
  if (buttons.length > 3) {
    throw new Error('WhatsApp Cloud API supports a maximum of 3 buttons.');
  }

  const client = await getClient();
  await client.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(btn => ({
          type: 'reply',
          reply: { id: btn.id, title: btn.title }
        }))
      }
    }
  });
}

// ─── Send media ───────────────────────────────────────────────────────────────

async function sendMedia(to, fileUrl, filename, caption) {
  const client = await getClient();
  await client.post(`/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      link: fileUrl,
      filename: filename,
      caption: caption || ''
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  if (!raw) return raw;
  // Meta sends raw digits, we just remove the `whatsapp:` prefix if it exists to be safe
  return raw.replace(/^whatsapp:/i, '');
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
