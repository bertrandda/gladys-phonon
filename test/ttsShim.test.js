// The TTS command goes through the SDK's own WebSocket handling: these tests
// drive it with the SDK's fake Gladys, whose `fake.send` plays Gladys' side of
// the socket exactly like the real client receives it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { COMMAND_RESULT, onTtsSynthesize, TTS_SYNTHESIZE } from '../src/ttsShim.js';

test('tts.synthesize is answered with the audio in command-result data', async () => {
  const gladys = createFakeGladys();
  const calls = [];
  assert.equal(
    onTtsSynthesize(gladys, async (text, language) => {
      calls.push({ text, language });
      return 'audio/mpeg;base64,AAAA';
    }),
    'shim',
  );
  await gladys.connect();

  const ack = await gladys.fake.send(TTS_SYNTHESIZE, { text: 'Bonjour', language: 'fr' });
  assert.deepEqual(ack, { success: true, data: { audio: 'audio/mpeg;base64,AAAA' } });
  assert.deepEqual(calls, [{ text: 'Bonjour', language: 'fr' }]);

  // `language` is null for a request without user.
  await gladys.fake.send(TTS_SYNTHESIZE, { text: 'Hi' });
  assert.equal(calls[1].language, null);
});

test('a failing synthesis is acked as a failure with its message', async () => {
  const gladys = createFakeGladys();
  onTtsSynthesize(gladys, async () => {
    throw new Error('engine not ready');
  });
  await gladys.connect();
  const ack = await gladys.fake.send(TTS_SYNTHESIZE, { text: 'Bonjour', language: 'fr' });
  assert.deepEqual(ack, { success: false, error: 'engine not ready' });
});

test('the other messages still reach the SDK handlers', async () => {
  const gladys = createFakeGladys({ config: { model: 'phonon-31m-en' } });
  onTtsSynthesize(gladys, async () => 'audio/mpeg;base64,AAAA');
  let updated = null;
  gladys.onConfigUpdated(async (config) => {
    updated = config;
  });
  gladys.onAction('ping', async () => 'pong');
  await gladys.connect();

  await gladys.fake.configUpdated({ model: 'phonon-40m-fr' });
  assert.deepEqual(updated, { model: 'phonon-40m-fr' });
  assert.deepEqual(await gladys.fake.action('ping'), { success: true, data: { message: 'pong' } });
});

test('a non-JSON message is left to the SDK', async () => {
  const gladys = createFakeGladys();
  onTtsSynthesize(gladys, async () => 'audio/mpeg;base64,AAAA');
  await gladys._handleMessage('not json');
  assert.equal(gladys.fake.wsMessages.filter((m) => m.type === COMMAND_RESULT).length, 0);
});

test('the SDK handler is used as soon as the SDK has one', () => {
  const registered = [];
  const gladys = { onTtsSynthesize: (handler) => registered.push(handler) };
  const handler = async () => 'audio/mpeg;base64,AAAA';
  assert.equal(onTtsSynthesize(gladys, handler), 'sdk');
  assert.deepEqual(registered, [handler]);
});

test('an SDK without the internals the shim needs is refused at startup', () => {
  assert.throws(() => onTtsSynthesize({}, async () => ''), /pin the SDK version/);
});
