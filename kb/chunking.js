'use strict';

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 64;

const SEP = '\n\n';
const FENCE_RE = /^`{3,}/; // fence de 3+ crases no início da linha
const HEADER_RE = /^#{1,6}\s/; // header markdown (# … ######)

/**
 * Quebra um texto em chunks determinísticos, ciente de markdown. O mesmo input
 * produz sempre o mesmo output (mesma contagem e mesmos limites) — saída pura
 * de `(text, size, overlap)`, sem aleatoriedade.
 *
 * Estratégia (hierárquica):
 *  1. Casos-base: vazio/whitespace → []; texto ≤ `size` → [texto].
 *  2. Segmentação estrutural (na ordem do documento):
 *     - blocos de código cercados por ``` (fence de 3+ crases até a fence de
 *       fechamento) são **segmentos atômicos** — nunca partidos no meio;
 *     - fora dos blocos, segmenta por headers (`^#{1,6}\s`) e parágrafos
 *       (`\n\n+`).
 *  3. Agrupamento greedy: une segmentos com `\n\n` enquanto couberem em `size`;
 *     ao exceder, fecha o chunk e começa outro.
 *  4. Fallback por caractere: um segmento isolado maior que `size` degrada em
 *     janelas de `size` avançando `size - overlap` por passo (não trava).
 *
 * O `overlap` só se aplica no fallback por caractere (passo 4); entre chunks
 * estruturais (passo 3) NÃO há sobreposição.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.size=512]    tamanho máximo do chunk (caracteres).
 * @param {number} [opts.overlap=64]  sobreposição entre janelas do fallback.
 * @returns {string[]}
 */
function chunkText(text, opts = {}) {
  const size = opts.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (size <= 0) throw new Error('chunk size deve ser > 0');
  if (overlap < 0 || overlap >= size) {
    throw new Error('overlap deve estar em [0, size)');
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
      // Segmento isolado grande demais: fecha o que houver e degrada por caractere.
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
 * Segmenta o texto em unidades estruturais (na ordem do documento):
 * blocos de código atômicos, e fora deles headers/parágrafos.
 * @param {string} text já normalizado (trim aplicado).
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
      // Bloco de código cercado: do fence de abertura até o de fechamento.
      flushText();
      const start = i;
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) i += 1;
      if (i < lines.length) i += 1; // consome a fence de fechamento, se houver
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
 * Divide um bloco de prosa por parágrafos (`\n\n+`) e por headers — um header
 * inicia um novo segmento (levando consigo as linhas seguintes do parágrafo).
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
 * Fallback por caractere — paridade EXATA com o algoritmo original: janela de
 * `size`, avançando `step = size - overlap`, encerrando quando a janela atinge
 * o fim do texto.
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
