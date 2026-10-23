import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { findModel, normalizeLanguage, resolveModel } from '../src/models.js';

test('normalizeConfig fills the defaults and drops empty values', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(
    normalizeConfig({
      model: ' phonon-40m-fr ',
      hf_token: '',
      voice: '',
      speech_rate: 'x',
      quant: 'q4',
    }),
    { ...DEFAULT_CONFIG, model: 'phonon-40m-fr' },
  );
  assert.equal(normalizeConfig({ quant: 'f32', speech_rate: 'faster' }).quant, 'f32');
  assert.equal(normalizeConfig({ speech_rate: 'faster' }).speech_rate, 'faster');
  // An inherited property is not a speech rate.
  assert.equal(normalizeConfig({ speech_rate: 'constructor' }).speech_rate, 'normal');
});

test('no model selected: nothing to resolve', () => {
  assert.equal(resolveModel(normalizeConfig({})), null);
});

test('a single-language model speaks its language whatever the language field', () => {
  const resolved = resolveModel(normalizeConfig({ model: 'phonon-40m-de', language: 'fr' }));
  assert.equal(resolved.model, findModel('phonon-40m-de'));
  assert.equal(resolved.lang, 'de');
  assert.equal(resolveModel({ model: 'phonon-31m-en' }).lang, 'en');
});

test('the multilingual model needs one of its languages', () => {
  assert.ok(resolveModel({ model: 'phonon-40m-multilingual', language: null }).error);
  assert.ok(resolveModel({ model: 'phonon-40m-multilingual', language: 'it' }).error);
  assert.equal(resolveModel({ model: 'phonon-40m-multilingual', language: 'pt' }).lang, 'pt');
});

test('an unknown model is a configuration error', () => {
  const { error } = resolveModel({ model: 'phonon-99m' });
  assert.match(error.en, /Unknown model/);
  assert.match(error.fr, /Modèle inconnu/);
});

test('normalizeLanguage keeps the two-letter language', () => {
  assert.equal(normalizeLanguage('fr-FR'), 'fr');
  assert.equal(normalizeLanguage('EN'), 'en');
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(null), null);
});
