'use strict';

const { EMBED_DIM } = require('../db');

/**
 * Local-first embedding provider via transformers.js (@huggingface/transformers).
 *
 * The model is loaded lazily: the dynamic `import()` only happens on the
 * FIRST call to `embed()`. This way, importing this file (or running the test
 * suite, which uses the fake provider) NEVER downloads a model nor touches the network.
 *
 * `@huggingface/transformers` is an OPTIONAL dependency: if it is not
 * installed, the 1st call to `embed()` throws a clear error, but `npm install`
 * and `npm test` keep working.
 *
 * Default model: `paraphrase-multilingual-MiniLM-L12-v2` (multilingual, includes
 * PT), dimension === EMBED_DIM (384). It is a SYMMETRIC model: query and passage
 * use the same encoding, so it does NOT need `query:`/`passage:` prefixes (unlike
 * the models of the e5 family). That is why the `embed(texts)` API remains
 * indistinct between query and document.
 */
function createTransformersProvider(opts = {}) {
  const modelId = opts.model || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  let extractorPromise = null;

  async function getExtractor() {
    if (!extractorPromise) {
      // dynamic import() — only runs when someone calls embed().
      let transformers;
      try {
        transformers = await import('@huggingface/transformers');
      } catch (err) {
        throw new Error(
          'Provider "transformers" requires @huggingface/transformers installed ' +
            '(optional dependency). Run `npm install @huggingface/transformers`. ' +
            `Cause: ${err.message}`
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
        // pooling 'mean' + normalize ensures L2 norm ≈ 1 (same as the fake).
        const tensor = await extractor(text, { pooling: 'mean', normalize: true });
        out.push(Float32Array.from(tensor.data));
      }
      return out;
    },
  };
}

module.exports = { createTransformersProvider };
