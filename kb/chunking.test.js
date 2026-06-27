'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP } = require('./chunking');

// ---------------------------------------------------------------------------
// Exports e casos-base preservados.
// ---------------------------------------------------------------------------
test('exports e defaults preservados', () => {
  assert.equal(typeof chunkText, 'function');
  assert.equal(DEFAULT_CHUNK_SIZE, 512);
  assert.equal(DEFAULT_OVERLAP, 64);
});

test('casos-base: vazio/whitespace → [], curto → [texto]', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  \t '), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
  assert.deepEqual(chunkText('oi mundo'), ['oi mundo']);
  // texto exatamente do tamanho de size → 1 chunk (trim aplicado).
  assert.deepEqual(chunkText('abcde', { size: 5, overlap: 1 }), ['abcde']);
});

test('validações de size/overlap', () => {
  assert.throws(() => chunkText('x', { size: 0 }), /chunk size/);
  assert.throws(() => chunkText('x', { size: -1 }), /chunk size/);
  assert.throws(() => chunkText('x', { size: 10, overlap: -1 }), /overlap/);
  assert.throws(() => chunkText('x', { size: 10, overlap: 10 }), /overlap/);
});

// ---------------------------------------------------------------------------
// Determinismo: mesma entrada → mesma lista (chamada dupla).
// ---------------------------------------------------------------------------
test('determinístico (deepEqual em 2 chamadas)', () => {
  const text = [
    '# Título',
    '',
    'Um parágrafo de prosa razoavelmente longo. '.repeat(8).trim(),
    '',
    '```js',
    'const x = 1;',
    'console.log(x);',
    '```',
    '',
    '## Outra seção',
    '',
    'Mais texto aqui para forçar múltiplos chunks. '.repeat(6).trim(),
  ].join('\n');

  const a = chunkText(text, { size: 120, overlap: 20 });
  const b = chunkText(text, { size: 120, overlap: 20 });
  assert.ok(a.length > 1, 'gera vários chunks');
  assert.deepEqual(a, b, 'mesmo input → mesmo output');
});

// ---------------------------------------------------------------------------
// Bloco de código que cabe em `size` NÃO é partido (fences íntegras).
// ---------------------------------------------------------------------------
test('bloco de código < size é preservado num único chunk (sem fence órfã)', () => {
  const code = ['```js', 'function f() {', '  return 42;', '}', '```'].join('\n');
  const text = [
    'Prosa introdutória curta antes do bloco.',
    '',
    code,
    '',
    'Prosa de encerramento curta depois do bloco.',
  ].join('\n');

  // size grande o bastante para o bloco caber, mas o doc inteiro excede.
  const size = code.length + 5;
  const chunks = chunkText(text, { size, overlap: 10 });

  // exatamente um chunk contém o bloco completo (abertura + fechamento juntas).
  const holders = chunks.filter((c) => c.includes(code));
  assert.equal(holders.length, 1, 'o bloco vive inteiro num único chunk');

  // nenhuma fence órfã: todo chunk tem nº par de linhas de fence.
  for (const c of chunks) {
    const fences = c.split('\n').filter((l) => /^`{3,}/.test(l)).length;
    assert.equal(fences % 2, 0, `chunk sem fence órfã: ${JSON.stringify(c)}`);
  }
});

// ---------------------------------------------------------------------------
// Bloco/segmento maior que `size` degrada por caractere (não trava).
// ---------------------------------------------------------------------------
test('bloco gigante degrada por caractere (length>1, conteúdo coberto)', () => {
  const body = 'linha de codigo;\n'.repeat(60); // bem maior que size
  const code = '```\n' + body + '```';
  const chunks = chunkText(code, { size: 100, overlap: 20 });

  assert.ok(chunks.length > 1, 'segmento gigante vira vários chunks');
  for (const c of chunks) assert.ok(c.length <= 100, 'nenhum chunk excede size');

  // cobertura: cada caractere do segmento aparece em algum chunk (janelas cobrem tudo).
  const joined = chunks.join('');
  assert.ok(joined.includes('linha de codigo;'), 'conteúdo do bloco preservado');
  assert.ok(joined.length >= code.length, 'janelas cobrem todo o segmento');
});

// ---------------------------------------------------------------------------
// Paridade do fallback: entrada sem separadores markdown replica a janela
// exata do algoritmo original (regressão de memory.test.js).
// ---------------------------------------------------------------------------
test('paridade do fallback por caractere (sem separadores)', () => {
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
  // o caso específico afirmado pelo memory.test.js legado.
  assert.equal(chunkText(text, { size, overlap })[1], text.slice(step, step + size));
});

// ---------------------------------------------------------------------------
// Headers não se separam do início do parágrafo quando cabem juntos.
// ---------------------------------------------------------------------------
test('header agrupado com seu parágrafo quando cabem juntos', () => {
  const text = [
    '# Cabeçalho A',
    '',
    'Parágrafo curto sob A.',
    '',
    'Parágrafo de enchimento bem longo para forçar mais de um chunk. '.repeat(5).trim(),
  ].join('\n');

  const chunks = chunkText(text, { size: 120, overlap: 20 });
  const holder = chunks.find((c) => c.includes('# Cabeçalho A'));
  assert.ok(holder, 'há um chunk com o header');
  assert.ok(
    holder.includes('Parágrafo curto sob A.'),
    'header fica junto do parágrafo que cabe com ele'
  );
});
