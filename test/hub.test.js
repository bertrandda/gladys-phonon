import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalizedError } from '../src/errors.js';
import { checkpointFiles, Hub, readConditioners } from '../src/hub.js';
import { startFakeHub } from './helpers/fakeServers.js';

const CONFIG = Buffer.from(
  JSON.stringify({ conditioners: [{ name: 'num_speakers' }, { name: 'duration_delta' }] }),
);
const REPOS = {
  'gradium/phonon-31m-en': {
    sha: 'aaa',
    files: {
      'config.json': CONFIG,
      'tokenizer.json': Buffer.from('{}'),
      'model.q8.gguf': Buffer.alloc(4096, 8),
      'model.safetensors': Buffer.alloc(8192, 32),
      'default-voice.safetensors': Buffer.alloc(256, 1),
      'README.md': Buffer.from('# readme'),
    },
  },
  'gradium/phonon-40m-fr': {
    sha: 'bbb',
    gated: true,
    files: { 'config.json': CONFIG, 'tokenizer.json': Buffer.from('{}') },
  },
};

let hub;
let fake;
let dir;

before(async () => {
  fake = await startFakeHub(REPOS);
  dir = await mkdtemp(join(tmpdir(), 'phonon-hub-'));
  hub = new Hub({ modelsDir: dir, hubUrl: fake.url });
});

after(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

test('resolveRepo gives the commit and the files with their sizes', async () => {
  const info = await hub.resolveRepo('gradium/phonon-31m-en');
  assert.equal(info.sha, 'aaa');
  assert.equal(info.files.get('model.q8.gguf').size, 4096);
  assert.match(info.files.get('model.q8.gguf').sha256, /^[0-9a-f]{64}$/);
});

test('resolveRepo answers from disk when the Hub is unreachable', async () => {
  await hub.resolveRepo('gradium/phonon-31m-en');
  const offline = new Hub({ modelsDir: dir, hubUrl: 'http://127.0.0.1:9' });
  assert.equal((await offline.resolveRepo('gradium/phonon-31m-en')).sha, 'aaa');
  await assert.rejects(offline.resolveRepo('gradium/never-seen'), (e) => {
    assert.ok(e instanceof LocalizedError);
    assert.match(e.messages.fr, /Impossible de joindre Hugging Face/);
    return true;
  });
});

test('resolveRepo reports a missing repo', async () => {
  await assert.rejects(hub.resolveRepo('gradium/nope'), { status: 404 });
});

test('checkpointFiles picks the weights of the quantization and the voices', () => {
  const info = {
    repo: 'r',
    files: new Map(
      [
        'config.json',
        'tokenizer.json',
        'model.q8.gguf',
        'model.safetensors',
        'default-voice.safetensors',
        'voices/anna.safetensors',
        'embeddings/bob.safetensors',
        'voices/nested/x.safetensors',
        'README.md',
      ].map((f) => [f, {}]),
    ),
  };
  assert.deepEqual(checkpointFiles(info, 'q8'), {
    files: [
      'config.json',
      'tokenizer.json',
      'model.q8.gguf',
      'voices/anna.safetensors',
      'embeddings/bob.safetensors',
      'default-voice.safetensors',
    ],
    weights: 'model.q8.gguf',
  });
  assert.equal(checkpointFiles(info, 'f32').weights, 'model.safetensors');
  info.files.delete('model.q8.gguf');
  assert.equal(checkpointFiles(info, 'q8').weights, 'model.safetensors');
  info.files.delete('model.safetensors');
  assert.throws(() => checkpointFiles(info, 'q8'), LocalizedError);
});

test('ensureFile downloads once, reports progress and checks the content', async () => {
  const info = await hub.resolveRepo('gradium/phonon-31m-en');
  const progress = [];
  const path = await hub.ensureFile(info, 'model.q8.gguf', { onProgress: (n) => progress.push(n) });
  assert.equal(path, join(dir, 'gradium/phonon-31m-en/aaa/model.q8.gguf'));
  assert.equal((await readFile(path)).length, 4096);
  assert.equal(progress.at(-1), 4096);

  const before = fake.requests.length;
  assert.equal(await hub.ensureFile(info, 'model.q8.gguf'), path);
  assert.equal(fake.requests.length, before, 'no second download');

  assert.equal(
    await readConditioners(await hub.ensureFile(info, 'config.json')).then((c) => c.length),
    2,
  );
});

test('ensureFile refuses a file whose checksum does not match, and leaves nothing behind', async () => {
  const info = await hub.resolveRepo('gradium/phonon-31m-en');
  const tampered = { ...info, files: new Map(info.files) };
  tampered.files.set('model.safetensors', { size: 8192, sha256: '0'.repeat(64) });
  await assert.rejects(hub.ensureFile(tampered, 'model.safetensors'), /checksum mismatch/);
  const files = await readdir(join(dir, 'gradium/phonon-31m-en/aaa'));
  assert.ok(!files.some((f) => f.startsWith('model.safetensors')), files.join());
});

test('gated models: a token is needed, then an account that accepted the terms', async () => {
  const info = await hub.resolveRepo('gradium/phonon-40m-fr');
  assert.equal(info.gated, true);

  await assert.rejects(hub.ensureFile(info, 'config.json'), (e) => {
    assert.match(e.messages.en, /gated model: accept its terms/);
    assert.match(e.messages.fr, /renseignez un token Hugging Face/);
    return true;
  });
  await assert.rejects(hub.ensureFile(info, 'config.json', { token: 'other-token' }), (e) => {
    assert.equal(e.status, 403);
    assert.match(e.messages.fr, /acceptez ses conditions/);
    return true;
  });
  const path = await hub.ensureFile(info, 'config.json', { token: 'good-token' });
  assert.ok(path.endsWith('gradium/phonon-40m-fr/bbb/config.json'));
  assert.equal(fake.requests.at(-1).authorization, 'Bearer good-token');
});

test('ensureFile refuses a file the repo does not have', async () => {
  const info = await hub.resolveRepo('gradium/phonon-31m-en');
  await assert.rejects(hub.ensureFile(info, 'nope.bin'), LocalizedError);
});
