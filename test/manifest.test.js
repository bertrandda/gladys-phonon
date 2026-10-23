// -----------------------------------------------------------------------------
// Consistency between gladys-assistant-integration.json and the code: the
// store indexer validates the manifest, but only these tests know which
// handlers, models and voices the code expects.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, QUANTS, SPEECH_RATES } from '../src/config.js';
import { MODELS, SUPPORTED_LANGUAGES } from '../src/models.js';
import { catalog } from '../src/catalog.js';
import { voiceOptions } from '../src/voiceLabels.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const field = (key) => manifest.config_schema.find((f) => f.key === key);
const values = (key) => field(key).options.map((o) => o.value);

// Actions registered by src/integration.js.
const ACTIONS = ['test_voice', 'list_gradium_voices', 'restart_engine'];

test('the manifest declares a TTS provider on the voice assistant shelf', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'tts');
  assert.deepEqual(manifest.categories, ['assistants']);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('version, package.json and the image tag agree', () => {
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.docker_image, new RegExp(`:${manifest.version.replace(/\./g, '\\.')}$`));
});

test('the TTS type needs a Gladys release that knows it', () => {
  const [major, minor] = manifest.gladys_version.replace(/^>=/, '').split('.').map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 3), manifest.gladys_version);
});

test('descriptions hold 10 to 100 characters in English and French', () => {
  for (const lang of ['en', 'fr']) {
    const text = manifest.description[lang];
    assert.ok(text.length >= 10 && text.length <= 100, `${lang}: ${text.length}`);
  }
});

test('the speech server sub-container is pinned and stays on the private network', () => {
  const [phonon] = manifest.containers;
  assert.equal(manifest.containers.length, 1);
  assert.equal(phonon.name, 'phonon');
  assert.match(phonon.docker_image, /^ghcr\.io\/gradium-ai\/ptts-openai-server:\d+\.\d+\.\d+$/);
  assert.equal(phonon.start, 'manual');
  assert.deepEqual(phonon.volumes, ['/models']);
  assert.equal(phonon.ports, undefined, 'no port published on the LAN');
  // Offline by construction: no catalog download, voices from the volume.
  assert.equal(phonon.env.PTTS_VOICE_CATALOG, '');
  assert.equal(phonon.env.PTTS_VOICE_DIR, '/models/voices');
  for (const key of Object.keys(phonon.env)) {
    assert.ok(!key.startsWith('GLADYS_'), key);
  }
});

test('the model has no default: Gladys cannot speak until the administrator picks one', () => {
  const model = field('model');
  assert.equal(model.required, true);
  assert.equal(model.default, undefined);
  assert.equal(DEFAULT_CONFIG.model, null);
  assert.deepEqual(
    values('model'),
    MODELS.map((m) => m.id),
  );
});

test('the language select lists the languages of the multilingual model', () => {
  assert.deepEqual(values('language'), SUPPORTED_LANGUAGES);
});

test('the voice select lists the default voice, the pinned catalog, then the custom voice', () => {
  assert.equal(field('voice').default, DEFAULT_CONFIG.voice);
  assert.deepEqual(field('voice').options, voiceOptions(catalog.voices));
  assert.equal(catalog.voices.length, field('voice').options.length - 2);
});

test('speech rate and weights options match the code', () => {
  assert.deepEqual(values('speech_rate'), Object.keys(SPEECH_RATES));
  assert.equal(field('speech_rate').default, DEFAULT_CONFIG.speech_rate);
  assert.deepEqual(values('quant'), QUANTS);
  assert.equal(field('quant').default, DEFAULT_CONFIG.quant);
});

test('every config field has a default in DEFAULT_CONFIG', () => {
  for (const f of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(Object.hasOwn(DEFAULT_CONFIG, f.key), f.key);
    if (f.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[f.key], f.default, f.key);
    }
  }
});

test('secrets are secret fields', () => {
  assert.equal(field('hf_token').type, 'secret');
  assert.equal(field('gradium_api_key').type, 'secret');
});

test('every action has a handler, and every text is bilingual', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    ACTIONS,
  );
  const texts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (['label', 'description', 'placeholder'].includes(key)) texts.push(value);
        else walk(value);
      }
    }
    return undefined;
  };
  walk(manifest.config_schema);
  walk(manifest.actions);
  for (const text of texts) {
    assert.equal(typeof text.en, 'string', JSON.stringify(text));
    assert.equal(typeof text.fr, 'string', JSON.stringify(text));
  }
});

test('section links are https and at most five per section', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.ok((section.links ?? []).length <= 5, section.key);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
    for (const lang of ['en', 'fr']) {
      assert.ok((section.description?.[lang] ?? '').length <= 1000, `${section.key}.${lang}`);
    }
  }
});
