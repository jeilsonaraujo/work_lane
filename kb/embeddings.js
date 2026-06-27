'use strict';

const crypto = require('node:crypto');
const { EMBED_DIM } = require('./db');

/**
 * Contrato de provider de embedding (injetável):
 *
 *   {
 *     name: string,
 *     dim: number,                                  // === EMBED_DIM
 *     embed(texts: string[]): Promise<Float32Array[]>
 *   }
 *
 * Os vetores devem ser normalizados (norma L2 ≈ 1) para que a distância do
 * sqlite-vec corresponda à similaridade de cosseno. O contrato é o mesmo para
 * o provider fake (testes), o transformers.js (local-first) e um futuro Voyage.
 */

/**
 * Normaliza um Float32Array in-place (L2). Vetor nulo é deixado como está.
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
 * Provider determinístico para testes — SEM rede, SEM modelo.
 *
 * Deriva o vetor de um hash do texto: o mesmo texto sempre produz o mesmo
 * vetor (determinismo) e textos diferentes produzem vetores diferentes.
 * O resultado é normalizado e tem dimensão `EMBED_DIM`.
 */
class FakeEmbeddingProvider {
  constructor({ dim = EMBED_DIM } = {}) {
    this.name = 'fake';
    this.dim = dim;
  }

  /**
   * Gera o vetor determinístico de um único texto. Exposto para que os testes
   * construam vetores de consulta esperados sem depender de detalhes internos.
   */
  embedOne(text) {
    const vec = new Float32Array(this.dim);
    // Hash expansível: encadeia sha256 até preencher `dim` floats.
    let block = 0;
    let filled = 0;
    while (filled < this.dim) {
      const digest = crypto
        .createHash('sha256')
        .update(`${block}:${text}`)
        .digest();
      // Cada byte vira um float em [-1, 1).
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
 * Factory de providers. Default = fake (offline). O provider real
 * (transformers.js) é carregado preguiçosamente para que importar este módulo
 * — e rodar os testes — nunca baixe modelo nem dependa de rede.
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
      // import lazy: só puxa o módulo (e o modelo) quando explicitamente pedido.
      const { createTransformersProvider } = require('./providers/transformers');
      return createTransformersProvider(opts);
    }
    default:
      throw new Error(`Provider de embedding desconhecido: ${name}`);
  }
}

module.exports = { FakeEmbeddingProvider, createProvider, normalize, EMBED_DIM };
