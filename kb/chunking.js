'use strict';

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 64;

const SEP = '\n\n';
const FENCE_RE = /^`{3,}/; // fence of 3+ backticks at the start of the line
const HEADER_RE = /^#{1,6}\s/; // markdown header (# … ######)

/**
 * Splits a text into deterministic, markdown-aware chunks. The same input
 * always produces the same output (same count and same boundaries) — a pure
 * function of `(text, size, overlap)`, with no randomness.
 *
 * Strategy (hierarchical):
 *  1. Base cases: empty/whitespace → []; text ≤ `size` → [text].
 *  2. Structural segmentation (in document order):
 *     - code blocks fenced by ``` (fence of 3+ backticks up to the closing
 *       fence) are **atomic segments** — never split in the middle;
 *     - outside the blocks, segments by headers (`^#{1,6}\s`) and paragraphs
 *       (`\n\n+`).
 *  3. Greedy grouping: joins segments with `\n\n` while they fit in `size`;
 *     when it exceeds, closes the chunk and starts another.
 *  4. Per-character fallback: an isolated segment larger than `size` degrades into
 *     windows of `size` advancing `size - overlap` per step (does not hang).
 *
 * `overlap` only applies in the per-character fallback (step 4); between
 * structural chunks (step 3) there is NO overlap.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.size=512]    maximum chunk size (characters).
 * @param {number} [opts.overlap=64]  overlap between fallback windows.
 * @returns {string[]}
 */
function chunkText(text, opts = {}) {
  const size = opts.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (size <= 0) throw new Error('chunk size must be > 0');
  if (overlap < 0 || overlap >= size) {
    throw new Error('overlap must be in [0, size)');
  }

  const normalized = String(text ?? '').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  const segments = segment(normalized);
  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  for (const seg of segments) {
    if (seg.length > size) {
      // Isolated segment too large: flush whatever exists and degrade per character.
      flush();
      for (const piece of charWindows(seg, size, overlap)) chunks.push(piece);
      continue;
    }
    if (buffer.length === 0) {
      buffer = seg;
    } else if (buffer.length + SEP.length + seg.length <= size) {
      buffer += SEP + seg;
    } else {
      flush();
      buffer = seg;
    }
  }
  flush();
  return chunks;
}

/**
 * Segments the text into structural units (in document order):
 * atomic code blocks, and outside them headers/paragraphs.
 * @param {string} text already normalized (trim applied).
 * @returns {string[]}
 */
function segment(text) {
  const lines = text.split('\n');
  const segments = [];
  let textBuf = [];

  const flushText = () => {
    if (textBuf.length) {
      for (const seg of splitProse(textBuf.join('\n'))) segments.push(seg);
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (FENCE_RE.test(lines[i])) {
      // Fenced code block: from the opening fence to the closing one.
      flushText();
      const start = i;
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) i += 1;
      if (i < lines.length) i += 1; // consumes the closing fence, if any
      const code = lines.slice(start, i).join('\n').trim();
      if (code) segments.push(code);
    } else {
      textBuf.push(lines[i]);
      i += 1;
    }
  }
  flushText();
  return segments;
}

/**
 * Splits a prose block by paragraphs (`\n\n+`) and by headers — a header
 * starts a new segment (carrying with it the following lines of the paragraph).
 * @param {string} text
 * @returns {string[]}
 */
function splitProse(text) {
  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    let cur = [];
    for (const line of para.split('\n')) {
      if (HEADER_RE.test(line) && cur.length) {
        const s = cur.join('\n').trim();
        if (s) out.push(s);
        cur = [line];
      } else {
        cur.push(line);
      }
    }
    const s = cur.join('\n').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Per-character fallback — EXACT parity with the original algorithm: window of
 * `size`, advancing `step = size - overlap`, stopping when the window reaches
 * the end of the text.
 * @param {string} text
 * @param {number} size
 * @param {number} overlap
 * @returns {string[]}
 */
function charWindows(text, size, overlap) {
  const step = size - overlap;
  const out = [];
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}

module.exports = { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP };
