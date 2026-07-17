'use strict';

/**
 * CONVERSION_MATRIX
 * Single source of truth for supported conversions.
 *
 * Each key is a detected file type (matched against magic bytes).
 * Each value is an array of { id, title } option objects.
 *
 * WhatsApp Reply Buttons cap out at 3 per message.
 * If any array here grows past 3 items, switch that type to a List Message
 * in services/messaging.js.
 *
 * ── What Gotenberg (v8) can and cannot do ────────────────────────────────────
 * Gotenberg wraps LibreOffice for *PDF output only*. It cannot produce
 * non-PDF output (no DOCX, no CSV, no XLSX). Conversions here that do not
 * target PDF are handled by in-process logic in services/convert.js.
 *
 * Supported:
 *   docx → pdf   via Gotenberg /forms/libreoffice/convert
 *   xlsx → pdf   via Gotenberg /forms/libreoffice/convert
 *   xlsx → csv   via in-process ExcelJS (no network call)
 *   pptx → pdf   via Gotenberg /forms/libreoffice/convert
 *   pdf  → docx  via pdf2docx-plus REST sidecar (POST PDF2DOCX_URL/convert)
 *
 * NOT supported:
 *   xlsx → docx  Gotenberg cannot produce non-PDF output.
 *                Add a sidecar if this is needed.
 */
const CONVERSION_MATRIX = {
  docx: [
    { id: 'convert_pdf', title: 'PDF' }
  ],
  xlsx: [
    { id: 'convert_pdf', title: 'PDF' },
    { id: 'convert_csv', title: 'CSV' }
  ],
  pptx: [
    { id: 'convert_pdf', title: 'PDF' }
  ],
  pdf: [
    { id: 'convert_docx', title: 'Word (.docx)' }
  ]
};

/**
 * Returns the list of conversion options for a given detected file type.
 * Returns an empty array for unsupported types — callers should check length.
 *
 * @param {string} detectedType — 'docx' | 'xlsx' | 'pptx' | 'pdf'
 * @returns {{ id: string, title: string }[]}
 */
function getConversionOptions(detectedType) {
  return CONVERSION_MATRIX[detectedType] || [];
}

/**
 * Maps a button reply id back to a target format string.
 * e.g. 'convert_pdf' → 'pdf'
 *
 * @param {string} buttonId
 * @returns {string}
 */
function targetFormatFromButtonId(buttonId) {
  return buttonId.replace(/^convert_/, '');
}

/**
 * Validates that a given button id is a valid option for the source type.
 *
 * @param {string} detectedType
 * @param {string} buttonId
 * @returns {boolean}
 */
function isValidConversion(detectedType, buttonId) {
  const options = getConversionOptions(detectedType);
  return options.some(opt => opt.id === buttonId);
}

module.exports = {
  CONVERSION_MATRIX,
  getConversionOptions,
  targetFormatFromButtonId,
  isValidConversion
};
