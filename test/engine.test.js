// The engine against the SDK's fake Gladys (container and status calls are
// recorded), a fake Hugging Face Hub and a fake speech server.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { STATUS } from '../src/engine.js';
import { createEngine } from '../src/integration.js';
import { silentLogger, startFakeHub, startFakePhonon, voiceFile } from './helpers/fakeServers.js';

const WITH_RATE = Buffer.from(
  JSON.stringify({ conditioners: [{ name: 'num_speakers' }, { name: 'duration_delta' }] }),
);
const WITHOUT_RATE = Buffer.from(JSON.stringify({ conditioners: [{ name: 'num_speakers' }] }));
const checkpoint = (config) => ({
  'config.json': config,
  'tokenizer.json': Buffer.from('{}'),
  'model.q8.gguf': Buffer.alloc(2048, 8),
  'model.safetensors': Buffer.alloc(4096, 32),
  'default-voice.safetensors': voiceFile('default'),
  'README.md': Buffer.from('readme'),
});
const ARNAUD = voiceFile('arnaud');
const CATALOG = {
  repo: 'gradium/phonon-voices',
  sha: 'ccc',
  voices: [
    {
      voice_id: 'aXMVwiUhITMrwPzd',
      name: 'Arnaud',
      language: 'fr',
      filename: 'voices/aXMVwiUhITMrwPzd.safetensors',
      size: ARNAUD.length,
      sha256: createHash('sha256').update(ARNAUD).digest('hex'),
    },
  ],
};

let hub;
let phonon;
let dir;
let gladys;
let logger;
let engine;

before(async () => {
  hub = await startFakeHub({
    'gradium/phonon-31m-en': { sha: 'aaa', files: checkpoint(WITH_RATE) },
    'gradium/phonon-40m-fr': { sha: 'bbb', gated: true, files: checkpoint(WITHOUT_RATE) },
    'gradium/phonon-voices': {
      sha: 'ccc',
      files: { 'voices/aXMVwiUhITMrwPzd.safetensors': ARNAUD },
    },
  });
  phonon = await startFakePhonon({ voices: ['aXMVwiUhITMrwPzd'] });
});

after(async () => {
  await hub.close();
  await phonon.close();
});

function build(containers = [{ name: 'phonon', status: 'running', desired: 'running' }]) {
  gladys = createFakeGladys({ containers });
  logger = silentLogger();
  ({ engine } = createEngine({
    gladys,
    logger,
    catalog: CATALOG,
    modelsDir: dir,
    phononUrl: phonon.url,
    hubUrl: hub.url,
    engineOptions: { pollIntervalMs: 5, healthTimeoutMs: 1000 },
  }));
  return engine;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phonon-engine-'));
  Object.assign(phonon.state, { healthy: true, framesPerRequest: 10, frameDelayMs: 0 });
  build();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const starts = () => gladys.fake.bodies('POST', '/container/phonon/start');
const restarts = () => gladys.fake.bodies('POST', '/container/phonon/restart');
const stops = () => gladys.fake.bodies('POST', '/container/phonon/stop');
const lastStatus = () => gladys.fake.bodies('POST', '/connection_status').at(-1);
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

test('without a model nothing runs, and Gladys cannot speak', async () => {
  await engine.apply(normalizeConfig({}));
  assert.equal(engine.status, STATUS.UNCONFIGURED);
  assert.deepEqual(starts(), []);
  assert.deepEqual(stops(), [{}], 'a server left running by a previous configuration is stopped');
  assert.equal(lastStatus().connected, false);
  assert.match(lastStatus().message.fr, /Aucun modèle sélectionné/);
  await assert.rejects(engine.synthesize('Bonjour', 'fr'), /No model selected/);
});

test('a stopped server is not stopped again', async () => {
  build([{ name: 'phonon', status: 'stopped', desired: 'stopped' }]);
  await engine.apply(normalizeConfig({}));
  assert.deepEqual(stops(), []);
});

test('a model is downloaded, then served from the local folder', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  assert.equal(engine.status, STATUS.READY, JSON.stringify(lastStatus()));
  assert.deepEqual(starts(), [
    {
      env: {
        PTTS_MODEL: '/models/gradium/phonon-31m-en/aaa',
        PTTS_LANG: 'en',
        PTTS_QUANT: 'q8',
      },
    },
  ]);
  assert.deepEqual(lastStatus(), {
    connected: true,
    message: {
      en: 'Ready: Phonon 31m · English, its own voice.',
      fr: 'Prêt : Phonon 31m · English, sa propre voix.',
    },
  });
  const folder = join(dir, 'gradium/phonon-31m-en/aaa');
  assert.deepEqual((await readdir(folder)).sort(), [
    'config.json',
    'default-voice.safetensors',
    'model.q8.gguf',
    'tokenizer.json',
  ]);
  const pinned = JSON.parse(
    await readFile(join(dir, 'gradium/phonon-31m-en/current.json'), 'utf8'),
  );
  assert.equal(pinned.sha, 'aaa');
  // Progress was reported while downloading.
  const progress = gladys.fake
    .bodies('POST', '/connection_status')
    .filter((s) => /Downloading/.test(s.message.en));
  assert.ok(progress.length >= 1);
  assert.match(progress.at(-1).message.fr, /Téléchargement de Phonon 31m · English : \d+ %/);

  const audio = await engine.synthesize('Hello', 'en');
  assert.match(audio, /^audio\/mpeg;base64,[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(audio.split(',')[1], 'base64').length, 10 * 192);
  assert.equal(phonon.state.requests.at(-1).voice, undefined);
});

test('applying the same configuration again changes nothing', async () => {
  const config = normalizeConfig({ model: 'phonon-31m-en' });
  await engine.apply(config);
  const downloads = hub.requests.length;
  await engine.apply(config);
  assert.equal(starts().length, 1);
  assert.equal(restarts().length, 0);
  assert.equal(hub.requests.length, downloads, 'nothing downloaded again');
});

test('an installed model starts without the Hub (offline)', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  const offline = createEngine({
    gladys,
    logger,
    catalog: CATALOG,
    modelsDir: dir,
    phononUrl: phonon.url,
    hubUrl: 'http://127.0.0.1:9',
    engineOptions: { pollIntervalMs: 5, healthTimeoutMs: 1000 },
  }).engine;
  await offline.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  assert.equal(offline.status, STATUS.READY);
});

test('a gated model needs the Hugging Face token', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-40m-fr' }));
  assert.equal(engine.status, STATUS.ERROR);
  assert.equal(lastStatus().connected, false);
  assert.match(lastStatus().message.fr, /renseignez un token Hugging Face/);
  assert.deepEqual(starts(), []);

  await engine.apply(normalizeConfig({ model: 'phonon-40m-fr', hf_token: 'good-token' }));
  assert.equal(engine.status, STATUS.READY);
  assert.equal(starts().at(-1).env.PTTS_LANG, 'fr');
});

test('changing the voice downloads it and restarts the server', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en', voice: 'aXMVwiUhITMrwPzd' }));
  assert.equal(restarts().length, 1, 'the server loads its voices at startup only');
  assert.ok(await exists(join(dir, 'voices/aXMVwiUhITMrwPzd.safetensors')));
  assert.match(lastStatus().message.en, /voice Arnaud/);
  await engine.synthesize('Bonjour', 'fr');
  assert.equal(phonon.state.requests.at(-1).voice, 'aXMVwiUhITMrwPzd');
});

test('the speech rate applies when the checkpoint has the setting', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en', speech_rate: 'faster' }));
  assert.equal(starts().at(-1).env.PTTS_CONDITION, 'duration_delta=-0.3');

  await engine.apply(
    normalizeConfig({ model: 'phonon-40m-fr', hf_token: 'good-token', speech_rate: 'slower' }),
  );
  assert.equal(starts().at(-1).env.PTTS_CONDITION, undefined);
  assert.match(lastStatus().message.en, /no speech rate setting/);
});

test('switching models keeps only the active one on disk', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en', quant: 'f32' }));
  assert.equal(starts().at(-1).env.PTTS_QUANT, 'f32');
  assert.ok(await exists(join(dir, 'gradium/phonon-31m-en/aaa/model.safetensors')));
  assert.ok(!(await exists(join(dir, 'gradium/phonon-31m-en/aaa/model.q8.gguf'))));

  await engine.apply(normalizeConfig({ model: 'phonon-40m-fr', hf_token: 'good-token' }));
  assert.ok(!(await exists(join(dir, 'gradium/phonon-31m-en'))));
  assert.ok(await exists(join(dir, 'gradium/phonon-40m-fr/bbb/model.q8.gguf')));
});

test('a server that crashes while loading is stopped and reported', async () => {
  phonon.state.healthy = false;
  build([{ name: 'phonon', status: 'exited', desired: 'running' }]);
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  assert.equal(engine.status, STATUS.ERROR);
  assert.deepEqual(stops(), [{}]);
  assert.match(lastStatus().message.fr, /consultez les journaux du conteneur « phonon »/);
  await assert.rejects(engine.synthesize('Hello'), /cannot speak yet/);
});

test('a server the supervisor keeps restarting is stopped at once', async () => {
  phonon.state.healthy = false;
  let restarts = 0;
  gladys.getContainers = async () => [
    { name: 'phonon', status: 'running', desired: 'running', started_at: `t${restarts++}` },
  ];
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  assert.equal(engine.status, STATUS.ERROR);
  assert.ok(restarts <= 3, `stopped after ${restarts} polls`);
  assert.deepEqual(stops(), [{}]);
});

test('a server found reloading (Gladys restarted) is waited for again', async () => {
  const config = normalizeConfig({ model: 'phonon-31m-en' });
  await engine.apply(config);
  phonon.state.healthy = false;
  setTimeout(() => {
    phonon.state.healthy = true;
  }, 50);
  await engine.apply(config);
  assert.equal(engine.status, STATUS.READY);
  assert.equal(starts().length, 2, 'started again, a no-op for the supervisor if it runs');
});

test('the token is only sent for gated models', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en', hf_token: 'stale-token' }));
  assert.equal(engine.status, STATUS.READY);
  assert.ok(hub.requests.filter((r) => r.path.includes('31m')).every((r) => !r.authorization));
});

test('a configuration error keeps the previous voice speaking', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  await engine.apply(normalizeConfig({ model: 'phonon-40m-multilingual' }));
  assert.equal(engine.status, STATUS.ERROR);
  assert.match(lastStatus().message.en, /needs a language.*keeps speaking meanwhile/);
  assert.ok(await engine.synthesize('Hello'));
});

test('force restarts the server even when nothing changed', async () => {
  const config = normalizeConfig({ model: 'phonon-31m-en' });
  await engine.apply(config);
  await engine.apply(config, { force: true });
  assert.equal(stops().length, 1);
  assert.equal(starts().length, 2);
  assert.equal(engine.status, STATUS.READY);
});

test('a text too long for the deadline speaks its beginning', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  engine.deadlineMs = 300;
  Object.assign(phonon.state, { framesPerRequest: 100, frameDelayMs: 20 });
  const audio = await engine.synthesize('A very long text', 'en');
  const bytes = Buffer.from(audio.split(',')[1], 'base64').length;
  assert.ok(bytes > 0 && bytes < 100 * 192);
  assert.ok(logger.lines.some((l) => l.level === 'warn' && /only its beginning/.test(l.text)));
});

test('syntheses run one at a time', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  Object.assign(phonon.state, { framesPerRequest: 5, frameDelayMs: 10 });
  const order = [];
  await Promise.all(
    ['one', 'two', 'three'].map((text) => engine.synthesize(text).then(() => order.push(text))),
  );
  assert.deepEqual(order, ['one', 'two', 'three']);
});

test('an empty text and a foreign language are handled', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en' }));
  await assert.rejects(engine.synthesize('   '), /Nothing to say/);
  await engine.synthesize('Bonjour', 'fr-FR');
  await engine.synthesize('Salut', 'fr');
  const warnings = logger.lines.filter((l) => /asked for "fr" speech/.test(l.text));
  assert.equal(warnings.length, 1, 'warned once');
});

test('the test action reports the generated speech', async () => {
  await engine.apply(normalizeConfig({ model: 'phonon-31m-en', voice: 'aXMVwiUhITMrwPzd' }));
  const result = await engine.test(null);
  assert.match(
    result.en,
    /^OK: 0\.2 s of speech \(2 KB of MP3\) generated in \d+\.\d s by Phonon 31m · English, voice Arnaud\.$/,
  );
  assert.match(result.fr, /^OK : 0,2 s de parole/);
  assert.equal(phonon.state.requests.at(-1).input, 'Hello, I am the voice of Gladys.');
});
