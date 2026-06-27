'use strict';

const { EMBED_DIM } = require('../db');

/**
 * Provider de embedding local-first via transformers.js (@huggingface/transformers).
 *
 * O modelo é carregado preguiçosamente: o `import()` dinâmico só acontece na
 * PRIMEIRA chamada a `embed()`. Assim, importar este arquivo (ou rodar a suíte
 * de testes, que usa o provider fake) NUNCA baixa modelo nem toca a rede.
 *
 * `@huggingface/transformers` é uma dependência OPCIONAL: se não estiver
 * instalada, a 1ª chamada a `embed()` lança um erro claro, mas `npm install`
 * e `npm test` continuam funcionando.
 *
 * Modelo default: bge-small multilíngue, dimensão === EMBED_DIM (384).
 */
function createTransformersProvider(opts = {}) {
  const modelId = opts.model || 'Xenova/bge-small-en-v1.5';
  let extractorPromise = null;

  async function getExtractor() {
    if (!extractorPromise) {
      // import() dinâmico — só executa quando alguém chama embed().
      let transformers;
      try {
        transformers = await import('@huggingface/transformers');
      } catch (err) {
        throw new Error(
          'Provider "transformers" requer @huggingface/transformers instalado ' +
            '(dependência opcional). Rode `npm install @huggingface/transformers`. ' +
            `Causa: ${err.message}`
        );
      }
      extractorPromise = transformers.pipeline('feature-extraction', modelId);
    }
    return extractorPromise;
  }

  return {
    name: `transformers:${modelId}`,
    dim: EMBED_DIM,
    async embed(texts) {
      const extractor = await getExtractor();
      const out = [];
      for (const text of texts) {
        // pooling 'mean' + normalize garante norma L2 ≈ 1 (igual ao fake).
        const tensor = await extractor(text, { pooling: 'mean', normalize: true });
        out.push(Float32Array.from(tensor.data));
      }
      return out;
    },
  };
}

module.exports = { createTransformersProvider };
