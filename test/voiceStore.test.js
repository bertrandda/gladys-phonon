import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalizedError } from '../src/errors.js';
import { Gradium } from '../src/gradium.js';
import { Hub } from '../src/hub.js';
import { selectVoice, VoiceStore } from '../src/voiceStore.js';
import { startFakeGradium, startFakeHub, voiceFile } from './helpers/fakeServers.js';

const ZOEY = voiceFile('zoey');
const ARNAUD = voiceFile('arnaud');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const CATALOG = {
  repo: 'gradium/phonon-voices',
  sha: 'ccc',
  voices: [
    {
      voice_id: 'NbpkqMVS3CJeq2j8',
      name: 'Zoey',
      filename: 'voices/NbpkqMVS3CJeq2j8.safetensors',
      size: ZOEY.length,
      sha256: sha256(ZOEY),
    },
    {
      voice_id: 'aXMVwiUhITMrwPzd',
      name: 'Arnaud',
      filename: 'voices/aXMVwiUhITMrwPzd.safetensors',
      size: ARNAUD.length,
      sha256: sha256(ARNAUD),
    },
  ],
};

let hubServer;
let gradiumServer;
let dir;
let store;

before(async () => {
  hubServer = await startFakeHub({
    'gradium/phonon-voices': {
      sha: 'ccc',
      files: {
        'voices/NbpkqMVS3CJeq2j8.safetensors': ZOEY,
        'voices/aXMVwiUhITMrwPzd.safetensors': ARNAUD,
        'custom/remote.safetensors': voiceFile('remote'),
      },
    },
  });
  gradiumServer = await startFakeGradium({ voices: [{ uid: 'StudioVoice01', name: 'Mine' }] });
});

after(async () => {
  await hubServer.close();
  await gradiumServer.close();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phonon-voices-'));
  store = new VoiceStore({
    dir: join(dir, 'voices'),
    catalog: CATALOG,
    hub: new Hub({ modelsDir: dir, hubUrl: hubServer.url }),
    gradium: new Gradium({ apiUrl: `${gradiumServer.url}/api` }),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('selectVoice understands every kind of voice', () => {
  assert.deepEqual(selectVoice({ voice: 'default' }, CATALOG), { kind: 'default' });
  assert.equal(selectVoice({ voice: 'aXMVwiUhITMrwPzd' }, CATALOG).name, 'aXMVwiUhITMrwPzd');
  assert.deepEqual(selectVoice({ voice: 'custom', custom_voice: 'StudioVoice01' }, CATALOG), {
    kind: 'gradium',
    name: 'custom-StudioVoice01',
    id: 'StudioVoice01',
  });
  const url = selectVoice(
    { voice: 'custom', custom_voice: 'https://x.test/v.safetensors' },
    CATALOG,
  );
  assert.equal(url.kind, 'url');
  assert.match(url.name, /^custom-[0-9a-f]{16}$/);
  assert.throws(
    () => selectVoice({ voice: 'custom', custom_voice: null }, CATALOG),
    LocalizedError,
  );
  assert.throws(
    () => selectVoice({ voice: 'custom', custom_voice: 'http://x.test/v' }, CATALOG),
    /https/,
  );
  assert.throws(() => selectVoice({ voice: 'gone' }, CATALOG), /Unknown voice/);
});

test('only the selected catalog voice is downloaded, and it replaces the previous one', async () => {
  let voice = await store.prepare({ voice: 'NbpkqMVS3CJeq2j8' });
  assert.deepEqual(voice, { name: 'NbpkqMVS3CJeq2j8', label: 'Zoey' });
  assert.deepEqual(await store.files(), ['NbpkqMVS3CJeq2j8.safetensors']);

  voice = await store.prepare({ voice: 'aXMVwiUhITMrwPzd' });
  assert.equal(voice.name, 'aXMVwiUhITMrwPzd');
  assert.deepEqual(await store.files(), ['aXMVwiUhITMrwPzd.safetensors']);

  const downloads = hubServer.requests.filter((r) => r.path.includes('/resolve/')).length;
  await store.prepare({ voice: 'aXMVwiUhITMrwPzd' });
  assert.equal(
    hubServer.requests.filter((r) => r.path.includes('/resolve/')).length,
    downloads,
    'an installed voice is not downloaded again',
  );
});

test("the model's own voice empties the voice folder", async () => {
  await store.prepare({ voice: 'NbpkqMVS3CJeq2j8' });
  assert.deepEqual(await store.prepare({ voice: 'default' }), { name: null, label: 'default' });
  assert.deepEqual(await store.files(), []);
});

test('a custom voice comes from Gradium Studio with the API key', async () => {
  const voice = await store.prepare({
    voice: 'custom',
    custom_voice: 'StudioVoice01',
    gradium_api_key: 'good-key',
  });
  assert.equal(voice.name, 'custom-StudioVoice01');
  assert.deepEqual(await store.files(), ['custom-StudioVoice01.safetensors']);
  assert.deepEqual(gradiumServer.requests.at(-1), {
    path: '/api/voices/embeddings/StudioVoice01/default/blob',
    key: 'good-key',
  });
});

test('a custom voice by ID without key, with a wrong key or unknown, fails and keeps the folder', async () => {
  await store.prepare({ voice: 'NbpkqMVS3CJeq2j8' });
  await assert.rejects(
    store.prepare({ voice: 'custom', custom_voice: 'StudioVoice01', gradium_api_key: null }),
    /needs the Gradium API key/,
  );
  await assert.rejects(
    store.prepare({ voice: 'custom', custom_voice: 'StudioVoice01', gradium_api_key: 'bad' }),
    /refused the API key/,
  );
  await assert.rejects(
    store.prepare({ voice: 'custom', custom_voice: 'Unknown0001', gradium_api_key: 'good-key' }),
    /Unknown Gradium voice/,
  );
  assert.deepEqual(await store.files(), ['NbpkqMVS3CJeq2j8.safetensors']);
});

test('a custom voice can be the https URL of a voice file', async () => {
  // The fake Hub plays the web server (http on 127.0.0.1; selectVoice requires
  // https, so the selection is built by hand).
  const url = `${hubServer.url}/gradium/phonon-voices/resolve/ccc/custom/remote.safetensors`;
  const target = join(dir, 'voices', 'custom-remote.safetensors');
  await mkdir(join(dir, 'voices'), { recursive: true });
  await store.download({ kind: 'url', name: 'custom-remote', url }, target, {});
  assert.deepEqual(await store.files(), ['custom-remote.safetensors']);
});

test('a download that fails or is not a voice file writes nothing', async () => {
  const missing = `${hubServer.url}/nothing`;
  await assert.rejects(
    store.download({ kind: 'url', name: 'x', url: missing }, join(dir, 'x'), {}),
    /HTTP 404/,
  );
  const notVoice = `${hubServer.url}/api/models/gradium/phonon-voices/revision/main`;
  await assert.rejects(
    store.download({ kind: 'url', name: 'x', url: notVoice }, join(dir, 'x'), {}),
    /not a Phonon voice file/,
  );
  assert.deepEqual(await readdir(dir), []);
});
