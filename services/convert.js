'use strict';

/**
 * services/convert.js
 *
 * Conversion router — buffer in, buffer out, no temp files anywhere.
 *
 * Three backends:
 *
 *   1. Gotenberg  (/forms/libreoffice/convert)
 *      Handles all conversions TO PDF.
 *      Inputs: docx, xlsx, pptx.
 *      Output is always PDF — Gotenberg cannot produce non-PDF output.
 *
 *   2. pdf2docx-plus  (POST /convert)
 *      Handles PDF → DOCX.
 *      Self-hosted FastAPI sidecar running pdf2docx-plus[rest].
 *      Returns a valid, editable DOCX buffer.
 *      URL configured via PDF2DOCX_URL env var (default: http://localhost:8001).
 *
 *   3. In-process via ExcelJS
 *      Handles xlsx → csv entirely in Node.js, no network call needed.
 */

const axios    = require('axios');
const FormData = require('form-data');
const ExcelJS  = require('exceljs');

const GOTENBERG_URL  = process.env.GOTENBERG_URL  || 'http://localhost:3000';
const PDF2DOCX_URL   = process.env.PDF2DOCX_URL   || 'http://localhost:8001';

// ─── MIME type map ────────────────────────────────────────────────────────────

const MIME_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:  'text/csv; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Convert a file buffer from one format to another.
 *
 * @param {Buffer} inputBuffer   — file content in memory
 * @param {string} sourceType    — 'docx' | 'xlsx' | 'pptx' | 'pdf'
 * @param {string} targetFormat  — 'pdf' | 'docx' | 'csv'
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string }>}
 */
async function convertFile(inputBuffer, sourceType, targetFormat) {
  // xlsx → csv: handled entirely in-process
  if (sourceType === 'xlsx' && targetFormat === 'csv') {
    return xlsxToCsv(inputBuffer);
  }

  // pdf → docx: handled by the pdf2docx-plus sidecar
  if (sourceType === 'pdf' && targetFormat === 'docx') {
    return pdfToDocxViaSidecar(inputBuffer);
  }

  // everything else → pdf: handled by Gotenberg
  if (targetFormat === 'pdf') {
    return convertToPdfViaGotenberg(inputBuffer, sourceType);
  }

  throw new Error(
    `Unsupported conversion: ${sourceType} → ${targetFormat}`
  );
}

// ─── Backend 1: Gotenberg (any Office format → PDF) ──────────────────────────

async function convertToPdfViaGotenberg(inputBuffer, sourceType) {
  const srcMime = MIME_TYPES[sourceType] || 'application/octet-stream';

  const form = new FormData();
  form.append('files', inputBuffer, {
    filename:    `input.${sourceType}`,
    contentType: srcMime
  });

  let response;
  try {
    response = await axios.post(
      `${GOTENBERG_URL}/forms/libreoffice/convert`,
      form,
      {
        headers:      form.getHeaders(),
        responseType: 'arraybuffer',
        timeout:      5 * 60 * 1000   // 5 min — large LibreOffice jobs can be slow
      }
    );
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${Buffer.from(err.response.data).toString('utf8').slice(0, 300)}`
      : err.message;
    throw new Error(`Gotenberg conversion failed (${sourceType}→pdf): ${detail}`);
  }

  const buf = Buffer.from(response.data);

  // Sanity-check: Gotenberg must always return a PDF
  if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
    throw new Error(
      `Gotenberg returned unexpected data for ${sourceType}→pdf ` +
      `(first bytes: ${buf.slice(0, 8).toString('hex')})`
    );
  }

  return { buffer: buf, mimeType: MIME_TYPES.pdf, ext: 'pdf' };
}

// ─── Backend 2: pdf2docx-plus sidecar (PDF → DOCX) ───────────────────────────

/**
 * POST multipart PDF to the pdf2docx-plus REST sidecar.
 *
 * API reference (pdf2docx-plus serve):
 *   POST /convert
 *   Body: multipart/form-data
 *     file      — the PDF bytes  (required)
 *     profile   — "fast" | "fidelity" | "semantic"  (optional, default: fidelity)
 *     timeout_s — int, max conversion time in seconds  (optional)
 *   Response: DOCX bytes
 *   Headers: X-Pages-Ok, X-Pages-Failed, X-Elapsed-Seconds
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string }>}
 */
async function pdfToDocxViaSidecar(inputBuffer) {
  const form = new FormData();
  form.append('file', inputBuffer, {
    filename:    'input.pdf',
    contentType: 'application/pdf'
  });
  form.append('profile',   'semantic');
  form.append('timeout_s', '240');     // 4-minute per-conversion watchdog

  let response;
  try {
    response = await axios.post(
      `${PDF2DOCX_URL}/convert`,
      form,
      {
        headers:      form.getHeaders(),
        responseType: 'arraybuffer',
        timeout:      5 * 60 * 1000   // 5-minute axios-level timeout
      }
    );
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${Buffer.from(err.response.data).toString('utf8').slice(0, 300)}`
      : err.message;
    throw new Error(`pdf2docx-plus conversion failed (pdf→docx): ${detail}`);
  }

  const buf = Buffer.from(response.data);

  // Sanity-check: a valid DOCX is a ZIP archive — magic bytes 50 4B (PK)
  if (buf.slice(0, 2).toString('hex') !== '504b') {
    throw new Error(
      `pdf2docx-plus returned unexpected data for pdf→docx ` +
      `(first bytes: ${buf.slice(0, 8).toString('hex')}). ` +
      'The PDF may be scanned/image-only or password-protected.'
    );
  }

  const pagesOk     = response.headers['x-pages-ok'];
  const pagesFailed = response.headers['x-pages-failed'];
  if (pagesOk !== undefined) {
    console.log(`[pdf2docx] pages ok=${pagesOk} failed=${pagesFailed}`);
  }

  return { buffer: buf, mimeType: MIME_TYPES.docx, ext: 'docx' };
}

// ─── Backend 3: in-process xlsx → csv ────────────────────────────────────────

/**
 * Convert the first sheet of an Excel workbook to CSV entirely in memory.
 * Uses ExcelJS — no temp files, no child processes.
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string }>}
 */
async function xlsxToCsv(inputBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(inputBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('The Excel file has no worksheets.');
  }

  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const val = cell.text != null ? String(cell.text) : '';
      // RFC 4180: escape fields containing commas, double-quotes, or newlines
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        cells.push(`"${val.replace(/"/g, '""')}"`);
      } else {
        cells.push(val);
      }
    });
    rows.push(cells.join(','));
  });

  const buffer = Buffer.from(rows.join('\r\n'), 'utf8');
  return { buffer, mimeType: MIME_TYPES.csv, ext: 'csv' };
}

module.exports = { convertFile, MIME_TYPES };
