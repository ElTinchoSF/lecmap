// Regression del fix de undici (T10): el multipart enviado por groqFetch
// debe conservar el campo de archivo. En producción, mezclar el FormData
// global de Node con el fetch de undici@8 enviaba el multipart vacío y el
// worker respondía 400 "falta el campo audio".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { upstreamFetch, upstreamAgent, FormData } from '../src/net.js';

test('upstreamFetch envía el multipart con el campo audio intacto', async () => {
  const seen = { ct: '', body: Buffer.alloc(0) };
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.ct = req.headers['content-type'] || '';
      seen.body = Buffer.concat(chunks);
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  try {
    const form = new FormData();
    form.append(
      'audio',
      new Blob([Buffer.from('bytes-de-audio')], { type: 'audio/mp4' }),
      'clase.m4a',
    );
    const res = await upstreamFetch(
      `http://127.0.0.1:${srv.address().port}/transcribe`,
      { method: 'POST', body: form, dispatcher: upstreamAgent },
    );
    assert.equal(res.status, 200);
    assert.match(seen.ct, /^multipart\/form-data; boundary=/);
    const body = seen.body.toString('latin1');
    assert.match(body, /name="audio"/, 'el campo audio debe estar presente');
    assert.match(body, /filename="clase.m4a"/);
    assert.ok(body.includes('bytes-de-audio'), 'el contenido del archivo viaja');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
