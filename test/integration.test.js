// The whole integration as Gladys drives it, through the SDK's fake Gladys:
// install with no model, the administrator saves a model, Gladys asks for
// speech (external-integration.tts.synthesize, onTtsSynthesize), the actions
// of the Configuration screen.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createEngine, registerIntegration } from '../src/integration.js';
import {
  silentLogger,
  startFakeGradium,
  startFakeHub,
  startFakePhonon,
  voiceFile,
} from './helpers/fakeServers.js';

const CATALOG = { repo: 'gradium/phonon-voices', sha: 'ccc', voices: [] };

let hub;
let phonon;
let gradium;
let dir;
let gladys;
let engine;

before(async () => {
  hub = await startFakeHub({
    'gradium/phonon-31m-en': {
      sha: 'aaa',
      files: {
        'config.json': Buffer.from('{"conditioners":[]}'),
        'tokenizer.json': Buffer.from('{}'),
        'model.q8.gguf': Buffer.alloc(1024, 8),
        'default-voice.safetensors': voiceFile('default'),
      },
    },
  });
  phonon = await startFakePhonon();
  gradium = await startFakeGradium({
    voices: [
      { uid: 'StudioVoice01', name: 'Mine', language: 'fr' },
      { uid: 'StudioVoice02', name: 'Clone', language: null },
    ],
  });
});

after(async () => {
  await hub.close();
  await phonon.close();
  await gradium.close();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phonon-integration-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function install(config = {}) {
  gladys = createFakeGladys({
    config,
    containers: [{ name: 'phonon', status: 'stopped', desired: 'stopped' }],
  });
  const logger = silentLogger();
  const built = createEngine({
    gladys,
    logger,
    catalog: CATALOG,
    modelsDir: dir,
    phononUrl: phonon.url,
    hubUrl: hub.url,
    gradiumUrl: `${gradium.url}/api`,
    engineOptions: { pollIntervalMs: 5, healthTimeoutMs: 1000 },
  });
  engine = built.engine;
  registerIntegration(gladys, built);
  await gladys.connect();
  await engine.applying;
}

test('fresh install: unusable until a model is chosen, then speaks', async () => {
  await install();
  assert.match(
    gladys.fake.bodies('POST', '/connection_status').at(-1).message.en,
    /No model selected/,
  );
  const refused = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(refused.success, false);
  assert.match(refused.error, /No model selected/);

  await gladys.fake.configUpdated({ model: 'phonon-31m-en' });
  await engine.applying;
  assert.equal(gladys.fake.bodies('POST', '/connection_status').at(-1).connected, true);

  const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(ack.success, true);
  assert.match(ack.data.audio, /^audio\/mpeg;base64,/);
  assert.deepEqual(phonon.state.requests.at(-1), { input: 'Hello', response_format: 'mp3' });
});

test('a request without language (an announcement of an unknown user) is spoken', async () => {
  await install({ model: 'phonon-31m-en' });
  const ack = await gladys.fake.ttsSynthesize('Hello');
  assert.equal(ack.success, true);
});

test('an audio the SDK refuses is acked as a failure with the reason', async () => {
  await install({ model: 'phonon-31m-en' });
  // The SDK checks the clip against the contract before the ack (content
  // type, base64, 5 MB): a regression of the engine would surface here.
  engine.synthesize = async () => 'audio/flac;base64,AAAA';
  const ack = await gladys.fake.ttsSynthesize('Hello', 'en');
  assert.equal(ack.success, false);
  assert.match(ack.error, /content type must be one of/);
});

test('the test action speaks a sentence and reports it', async () => {
  await install({ model: 'phonon-31m-en' });
  const ack = await gladys.fake.action('test_voice', { text: 'Testing' });
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /^OK: /);
  assert.equal(phonon.state.requests.at(-1).input, 'Testing');
});

test('the test action fails clearly while no model is chosen', async () => {
  await install();
  const ack = await gladys.fake.action('test_voice', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /No model selected/);
});

test('list_gradium_voices shows the IDs of the account voices', async () => {
  await install({ gradium_api_key: 'good-key' });
  const ack = await gladys.fake.action('list_gradium_voices', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.en,
    'Copy an ID into "Custom voice":\nStudioVoice01 · fr · Mine\nStudioVoice02 · -- · Clone',
  );

  const refused = await (async () => {
    await install({ gradium_api_key: 'bad-key' });
    return gladys.fake.action('list_gradium_voices', {});
  })();
  assert.equal(refused.success, false);
  assert.match(refused.error, /refused the API key/);
});

test('restart_engine restarts the server and answers at once', async () => {
  await install({ model: 'phonon-31m-en' });
  const ack = await gladys.fake.action('restart_engine', {});
  assert.equal(ack.success, true);
  assert.match(ack.data.message.fr, /Relance du moteur vocal/);
  await engine.applying;
  assert.equal(gladys.fake.bodies('POST', '/container/phonon/start').length, 2);
});
