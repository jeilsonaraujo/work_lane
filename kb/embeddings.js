'use strict';

const crypto = require('node:crypto');
const { EMBED_DIM } = require('./db');

/**
 * Embedding provider contract (injectable):
 *
 *   {
 *     name: string,
 *     dim: number,                                  // === EMBED_DIM
 *     embed(texts: string[]): Promise<Float32Array[]>
 *   }
 *
 * The vectors must be normalized (L2 norm ≈ 1) so that the sqlite-vec distance
 * corresponds to cosine similarity. The contract is the same for the fake
 * provider (tests), transformers.js (local-first) and a future Voyage.
 */

/**
 * Normalizes a Float32Array in-place (L2). A null vector is left as is.
 */
function normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Deterministic provider for tests — NO network, NO model.
 *
 * Derives the vector from a hash of the text: the same text always produces the
 * same vector (determinism) and different texts produce different vectors.
 * The result is normalized and has dimension `EMBED_DIM`.
 */
class FakeEmbeddingProvider {
  constructor({ dim = EMBED_DIM } = {}) {
    this.name = 'fake';
    this.dim = dim;
  }

  /**
   * Generates the deterministic vector of a single text. Exposed so the tests
   * can build expected query vectors without depending on internal details.
   */
  embedOne(text) {
    const vec = new Float32Array(this.dim);
    // Expandable hash: chains sha256 until `dim` floats are filled.
    let block = 0;
    let filled = 0;
    while (filled < this.dim) {
      const digest = crypto
        .createHash('sha256')
        .update(`${block}:${text}`)
        .digest();
      // Each byte becomes a float in [-1, 1).
      for (let i = 0; i < digest.length && filled < this.dim; i++) {
        vec[filled++] = digest[i] / 127.5 - 1;
      }
      block++;
    }
    return normalize(vec);
  }

  async embed(texts) {
    return texts.map((t) => this.embedOne(t));
  }
}

/**
 * Provider factory. Default = fake (offline). The real provider
 * (transformers.js) is loaded lazily so that importing this module
 * — and running the tests — never downloads a model nor depends on the network.
 *
 * @param {string} [name='fake']
 * @param {object} [opts]
 * @returns {{name:string,dim:number,embed:(t:string[])=>Promise<Float32Array[]>}}
 */
function createProvider(name = 'fake', opts = {}) {
  switch (name) {
    case 'fake':
      return new FakeEmbeddingProvider(opts);
    case 'transformers': {
      // lazy import: only pulls the module (and the model) when explicitly requested.
      const { createTransformersProvider } = require('./providers/transformers');
      return createTransformersProvider(opts);
    }
    default:
      throw new Error(`Unknown embedding provider: ${name}`);
  }
}

module.exports = { FakeEmbeddingProvider, createProvider, normalize, EMBED_DIM };
