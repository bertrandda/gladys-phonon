import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalog,
  buildSiteData,
  compactJson,
  findSamples,
  setVoiceOptions,
} from '../scripts/sync-voices.mjs';
import { voiceLabel } from '../src/voiceLabels.js';

// Shapes of the gradium/phonon-voices catalog (commit 0ee1720).
const FILES = [
  'voices.jsonl',
  'voices/NbpkqMVS3CJeq2j8.safetensors',
  'voices/aXMVwiUhITMrwPzd.safetensors',
  'voices/QXNr0SvkukLB4wPq.safetensors',
  'samples/31m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/happy_01.ogg',
  'samples/31m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/question_01.ogg',
  'samples/40m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/exclamation_02.ogg',
  'samples/40m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/happy_01.ogg',
  'samples/56m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/happy_01.ogg',
  'samples/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8.ogg',
  'samples/40m/fr/fr-fr/male/2_arnaud_aXMVwiUhITMrwPzd/support_01.ogg',
  'samples/fr/fr-fr/male/2_arnaud_aXMVwiUhITMrwPzd.ogg',
  'samples/40m/en/characters/fairy_godmother_QXNr0SvkukLB4wPq/line_1.ogg',
  'samples/40m/en/characters/fairy_godmother_QXNr0SvkukLB4wPq/question_01.ogg',
];
const JSONL = [
  {
    filename: 'voices/NbpkqMVS3CJeq2j8.safetensors',
    name: 'Zoey',
    voice_id: 'NbpkqMVS3CJeq2j8',
    language: 'en',
    locale: 'en-us',
    gender: 'female',
    age: 'Adult',
    description: 'Playful.',
  },
  {
    filename: 'voices/aXMVwiUhITMrwPzd.safetensors',
    name: 'Arnaud',
    voice_id: 'aXMVwiUhITMrwPzd',
    language: 'fr',
    locale: 'fr-fr',
    gender: 'male',
    age: 'Middle-age',
    description: 'Low and firm.',
  },
  {
    filename: 'voices/QXNr0SvkukLB4wPq.safetensors',
    name: 'Fairy Godmother',
    voice_id: 'QXNr0SvkukLB4wPq',
    language: 'en',
    locale: 'characters',
    gender: null,
    age: null,
    description: 'A kind fairy godmother.',
  },
]
  .map((entry) => JSON.stringify(entry))
  .join('\n');

test('findSamples prefers the happy clip of each offered model size', () => {
  assert.deepEqual(findSamples(FILES, 'NbpkqMVS3CJeq2j8'), {
    '40m': 'samples/40m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/happy_01.ogg',
    '31m': 'samples/31m/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8/happy_01.ogg',
    default: 'samples/en/en-us/female/1_zoey_NbpkqMVS3CJeq2j8.ogg',
  });
  // Characters have lines instead; a voice may lack a size.
  assert.equal(
    findSamples(FILES, 'QXNr0SvkukLB4wPq')['40m'],
    'samples/40m/en/characters/fairy_godmother_QXNr0SvkukLB4wPq/line_1.ogg',
  );
  assert.equal(findSamples(FILES, 'aXMVwiUhITMrwPzd')['31m'], null);
});

test('buildCatalog sorts the voices French first and keeps their checksums', () => {
  const blobs = new Map([['voices/aXMVwiUhITMrwPzd.safetensors', { size: 10, sha256: 'ab' }]]);
  const catalog = buildCatalog({ sha: 'ccc', files: FILES, jsonl: JSONL, blobs });
  assert.equal(catalog.repo, 'gradium/phonon-voices');
  assert.equal(catalog.sha, 'ccc');
  assert.deepEqual(
    catalog.voices.map((v) => v.name),
    ['Arnaud', 'Fairy Godmother', 'Zoey'],
  );
  assert.equal(catalog.voices[0].size, 10);
  assert.equal(catalog.voices[0].sha256, 'ab');
  assert.equal(catalog.voices[1].size, null);
});

test('buildCatalog refuses a voice whose file is missing or whose id is odd', () => {
  assert.throws(
    () => buildCatalog({ sha: 'ccc', files: ['voices.jsonl'], jsonl: JSONL }),
    /is not in gradium\/phonon-voices@ccc/,
  );
  assert.throws(
    () =>
      buildCatalog({ sha: 'ccc', files: FILES, jsonl: '{"voice_id": "../x", "filename": "x"}' }),
    /unexpected voice_id/,
  );
});

test('voice labels name the language, the region and the traits', () => {
  assert.deepEqual(voiceLabel(JSON.parse(JSONL.split('\n')[1])), {
    en: 'French (France) · Arnaud — male, middle-aged',
    fr: "Français (France) · Arnaud — homme, d'âge mûr",
  });
  assert.deepEqual(voiceLabel(JSON.parse(JSONL.split('\n')[2])), {
    en: 'English · Fairy Godmother — character',
    fr: 'Anglais · Fairy Godmother — personnage',
  });
});

test('setVoiceOptions writes the default, catalog and custom options', () => {
  const catalog = buildCatalog({ sha: 'ccc', files: FILES, jsonl: JSONL });
  const manifest = { config_schema: [{ key: 'voice', type: 'select', options: [] }] };
  setVoiceOptions(manifest, catalog.voices);
  assert.deepEqual(
    manifest.config_schema[0].options.map((o) => o.value),
    ['default', 'aXMVwiUhITMrwPzd', 'QXNr0SvkukLB4wPq', 'NbpkqMVS3CJeq2j8', 'custom'],
  );
  assert.throws(() => setVoiceOptions({ config_schema: [] }, []), /no `voice` field/);
});

test('buildSiteData points the samples at the pinned commit', () => {
  const site = buildSiteData(buildCatalog({ sha: 'ccc', files: FILES, jsonl: JSONL }));
  assert.equal(site.base_url, 'https://huggingface.co/gradium/phonon-voices/resolve/ccc/');
  assert.equal(site.voices[0].label.en, 'French (France) · Arnaud — male, middle-aged');
  assert.deepEqual(site.voices[0].tags, {
    en: ['French (France)', 'male', 'middle-aged'],
    fr: ['Français (France)', 'homme', "d'âge mûr"],
  });
  assert.deepEqual(site.voices[1].tags.fr, ['Anglais', 'personnage']);
});

test('compactJson keeps short objects on one line', () => {
  assert.equal(compactJson({ a: { en: 'x', fr: 'y' } }), '{ "a": { "en": "x", "fr": "y" } }');
  const long = { label: { en: 'x'.repeat(60), fr: 'y'.repeat(60) } };
  assert.equal(
    compactJson(long),
    `{\n  "label": {\n    "en": "${'x'.repeat(60)}",\n    "fr": "${'y'.repeat(60)}"\n  }\n}`,
  );
  assert.equal(compactJson([]), '[]');
  assert.equal(compactJson({}), '{}');
});
