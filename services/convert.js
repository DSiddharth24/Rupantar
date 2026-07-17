'use strict';

/**
 * services/convert.js
 *
 * Thin wrapper around the Gotenberg HTTP API.
 * Buffer in → Buffer out. No temp files anywhere.
 *
 * Gotenberg is a Dockerized LibreOffice headless server that accepts
 * multipart/form-data POST requests and streams back the converted file.
 *
 * Docs: https://gotenberg.dev/docs/routes
 */

const axios    = require('axios');
const FormData = require('form-data');

const GOTENBERG_URL = process.env.GOTENBERG_URL || 'http://localhost:3000';

/**
 * Maps our internal type+target identifiers to Gotenberg route + input filename.
 *
 * Gotenberg infers the conversion from the file extension on the uploaded file,
 * so we supply a filename with the correct source extension.
 *
 * Routes used:
 *   /forms/libreoffice/convert  — for all Office ↔ Office/PDF conversions
 *   /forms/pdfengines/convert   — for PDF → DOCX (uses LibreOffice underneath too,
 *                                  but the pdfengines route is the correct one for
 *                                  PDF as input)
 */
const ROUTE_MAP = {
  // source → target
  'docx→pdf':  { route: '/forms/libreoffice/convert', srcExt: 'docx', nativeExt: 'pdf'  },
  'xlsx→pdf':  { route: '/forms/libreoffice/convert', srcExt: 'xlsx', nativeExt: 'pdf'  },
  'xlsx→docx': { route: '/forms/libreoffice/convert', srcExt: 'xlsx', nativeExt: 'docx' },
  'xlsx→csv':  { route: '/forms/libreoffice/convert', srcExt: 'xlsx', nativeExt: 'csv'  },
  'pptx→pdf':  { route: '/forms/libreoffice/convert', srcExt: 'pptx', nativeExt: 'pdf'  },
  'pdf→docx':  { route: '/forms/libreoffice/convert', srcExt: 'pdf',  nativeExt: 'docx' }
};

/**
 * Maps output extension to MIME type.
 */
const MIME_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:  'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/**
 * Convert a file buffer from one format to another using Gotenberg.
 *
 * @param {Buffer} inputBuffer   — file content in memory
 * @param {string} sourceType    — 'docx' | 'xlsx' | 'pptx' | 'pdf'
 * @param {string} targetFormat  — 'pdf' | 'docx' | 'csv'
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string }>}
 */
async function convertFile(inputBuffer, sourceType, targetFormat) {
  const key = `${sourceType}→${targetFormat}`;
  const mapping = ROUTE_MAP[key];

  if (!mapping) {
    throw new Error(`Unsupported conversion: ${sourceType} → ${targetFormat}`);
  }

  const form = new FormData();
  // Gotenberg uses the filename extension to detect the source format
  form.append('files', inputBuffer, {
    filename:    `input.${mapping.srcExt}`,
    contentType: MIME_TYPES[mapping.srcExt] || 'application/octet-stream'
  });

  const url = `${GOTENBERG_URL}${mapping.route}`;

  let response;
  try {
    response = await axios.post(url, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      // 5-minute timeout — large files through LibreOffice can be slow
      timeout: 5 * 60 * 1000
    });
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${Buffer.from(err.response.data).toString('utf8').slice(0, 200)}`
      : err.message;
    throw new Error(`Gotenberg conversion failed (${key}): ${detail}`);
  }

  const ext      = mapping.nativeExt;
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  return {
    buffer:   Buffer.from(response.data),
    mimeType,
    ext
  };
}

module.exports = { convertFile, MIME_TYPES };
