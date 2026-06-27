'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP } = require('./chunking');

// ---------------------------------------------------------------------------
// Exports and base cases preserved.
// ---------------------------------------------------------------------------
test('exports and defaults preserved', () => {
  assert.equal(typeof chunkText, 'function');
  assert.equal(DEFAULT_CHUNK_SIZE, 512);
  assert.equal(DEFAULT_OVERLAP, 64);
});

test('base cases: empty/whitespace → [], short → [text]', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  \t '), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
  assert.deepEqual(chunkText('hello world'), ['hello world']);
  // text exactly the size of `size` → 1 chunk (trim applied).
  assert.deepEqual(chunkText('abcde', { size: 5, overlap: 1 }), ['abcde']);
});

test('size/overlap validations', () => {
  assert.throws(() => chunkText('x', { size: 0 }), /chunk size/);
  assert.throws(() => chunkText('x', { size: -1 }), /chunk size/);
  assert.throws(() => chunkText('x', { size: 10, overlap: -1 }), /overlap/);
  assert.throws(() => chunkText('x', { size: 10, overlap: 10 }), /overlap/);
});

// ---------------------------------------------------------------------------
// Determinism: same input → same list (double call).
// ---------------------------------------------------------------------------
test('deterministic (deepEqual over 2 calls)', () => {
  const text = [
    '# Title',
    '',
    'A reasonably long paragraph of prose. '.repeat(8).trim(),
    '',
    '```js',
    'const x = 1;',
    'console.log(x);',
    '```',
    '',
    '## Another section',
    '',
    'More text here to force multiple chunks. '.repeat(6).trim(),
  ].join('\n');

  const a = chunkText(text, { size: 120, overlap: 20 });
  const b = chunkText(text, { size: 120, overlap: 20 });
  assert.ok(a.length > 1, 'generates several chunks');
  assert.deepEqual(a, b, 'same input → same output');
});

// ---------------------------------------------------------------------------
// A code block that fits within `size` is NOT split (fences intact).
// ---------------------------------------------------------------------------
test('code block < size is preserved in a single chunk (no orphan fence)', () => {
  const code = ['```js', 'function f() {', '  return 42;', '}', '```'].join('\n');
  const text = [
    'Short introductory prose before the block.',
    '',
    code,
    '',
    'Short closing prose after the block.',
  ].join('\n');

  // size large enough for the block to fit, but the whole doc exceeds it.
  const size = code.length + 5;
  const chunks = chunkText(text, { size, overlap: 10 });

  // exactly one chunk contains the whole block (opening + closing together).
  const holders = chunks.filter((c) => c.includes(code));
  assert.equal(holders.length, 1, 'the block lives whole in a single chunk');

  // no orphan fence: every chunk has an even number of fence lines.
  for (const c of chunks) {
    const fences = c.split('\n').filter((l) => /^`{3,}/.test(l)).length;
    assert.equal(fences % 2, 0, `chunk with no orphan fence: ${JSON.stringify(c)}`);
  }
});

// ---------------------------------------------------------------------------
// A block/segment larger than `size` degrades by character (does not hang).
// ---------------------------------------------------------------------------
test('huge block degrades by character (length>1, content covered)', () => {
  const body = 'line of code;\n'.repeat(60); // much larger than size
  const code = '```\n' + body + '```';
  const chunks = chunkText(code, { size: 100, overlap: 20 });

  assert.ok(chunks.length > 1, 'a huge segment becomes several chunks');
  for (const c of chunks) assert.ok(c.length <= 100, 'no chunk exceeds size');

  // coverage: every character of the segment appears in some chunk (windows cover everything).
  const joined = chunks.join('');
  assert.ok(joined.includes('line of code;'), 'block content preserved');
  assert.ok(joined.length >= code.length, 'windows cover the whole segment');
});

// ---------------------------------------------------------------------------
// Fallback parity: input with no markdown separators replicates the exact
// window of the original algorithm (regression from memory.test.js).
// ---------------------------------------------------------------------------
test('character fallback parity (no separators)', () => {
  const text = 'a'.repeat(1000) + 'b'.repeat(1000);
  const size = 300;
  const overlap = 50;
  const step = size - overlap;

  const expected = [];
  for (let start = 0; start < text.length; start += step) {
    expected.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }

  assert.deepEqual(chunkText(text, { size, overlap }), expected);
  // the specific case asserted by the legacy memory.test.js.
  assert.equal(chunkText(text, { size, overlap })[1], text.slice(step, step + size));
});

// ---------------------------------------------------------------------------
// Headers do not detach from the start of the paragraph when they fit together.
// ---------------------------------------------------------------------------
test('header grouped with its paragraph when they fit together', () => {
  const text = [
    '# Header A',
    '',
    'Short paragraph under A.',
    '',
    'Very long filler paragraph to force more than one chunk. '.repeat(5).trim(),
  ].join('\n');

  const chunks = chunkText(text, { size: 120, overlap: 20 });
  const holder = chunks.find((c) => c.includes('# Header A'));
  assert.ok(holder, 'there is a chunk with the header');
  assert.ok(
    holder.includes('Short paragraph under A.'),
    'header stays together with the paragraph that fits with it'
  );
});
