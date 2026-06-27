'use strict';

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 64;

/**
 * Quebra um texto em chunks determinísticos por tamanho de caractere, com
 * sobreposição. Sem dependências externas — o mesmo input produz sempre o mesmo
 * output (mesma contagem e mesmos limites).
 *
 * - Texto vazio/whitespace → [] (nada a indexar).
 * - Texto menor que `size` → 1 chunk.
 * - Caso geral → janelas de `size`, avançando `size - overlap` por passo.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.size=512]    tamanho da janela (caracteres).
 * @param {number} [opts.overlap=64]  sobreposição entre janelas consecutivas.
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

  const step = size - overlap;
  const chunks = [];
  for (let start = 0; start < normalized.length; start += step) {
    const piece = normalized.slice(start, start + size);
    chunks.push(piece);
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

module.exports = { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP };
