import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AUDIO_BYTES, PhononClient } from '../src/phononClient.js';
import { startFakePhonon } from './helpers/fakeServers.js';

let server;
let client;

before(async () => {
  server = await startFakePhonon({ voices: ['aXMVwiUhITMrwPzd'] });
  client = new PhononClient({ baseUrl: server.url });
});

after(() => server.close());

const reset = () =>
  Object.assign(server.state, { healthy: true, framesPerRequest: 10, frameDelayMs: 0 });

test('health follows the server, and a server that does not answer is unhealthy', async () => {
  reset();
  assert.equal(await client.health(), true);
  server.state.healthy = false;
  assert.equal(await client.health(), false);
  assert.equal(await new PhononClient({ baseUrl: 'http://127.0.0.1:9' }).health(), false);
});

test('voices lists the voices the server loaded', async () => {
  assert.deepEqual(await client.voices(), ['aXMVwiUhITMrwPzd']);
});

test('speech asks for MP3 and returns the whole audio', async () => {
  reset();
  const { audio, partial } = await client.speech({
    input: 'Bonjour',
    voice: 'aXMVwiUhITMrwPzd',
    deadline: Date.now() + 5000,
  });
  assert.equal(partial, false);
  assert.equal(audio.length, 10 * 192);
  assert.deepEqual(server.state.requests.at(-1), {
    input: 'Bonjour',
    response_format: 'mp3',
    voice: 'aXMVwiUhITMrwPzd',
  });
});

test("speech without voice uses the model's own voice", async () => {
  reset();
  await client.speech({ input: 'Hi', voice: null, deadline: Date.now() + 5000 });
  assert.equal(server.state.requests.at(-1).voice, undefined);
});

test('past the deadline, the complete frames received so far are returned', async () => {
  reset();
  Object.assign(server.state, { framesPerRequest: 100, frameDelayMs: 20 });
  const { audio, partial } = await client.speech({ input: 'Long', deadline: Date.now() + 300 });
  assert.equal(partial, true);
  assert.ok(audio.length > 0 && audio.length < 100 * 192, String(audio.length));
  assert.equal(audio.length % 192, 0, 'cut at a frame boundary');
});

test('a deadline reached before any audio is an error', async () => {
  reset();
  Object.assign(server.state, { framesPerRequest: 5, frameDelayMs: 200 });
  // The first frame arrives at once: ask for less time than that is impossible
  // to observe, so use an already passed deadline.
  await assert.rejects(client.speech({ input: 'x', deadline: Date.now() - 1 }), /took too long/);
});

test('the server errors come with their message', async () => {
  reset();
  await assert.rejects(
    client.speech({ input: 'x', voice: 'nobody', deadline: Date.now() + 5000 }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.messages.en, /unknown voice 'nobody'/);
      assert.match(e.messages.fr, /Le moteur vocal a refusé/);
      return true;
    },
  );
});

test('an unreachable server is reported', async () => {
  const down = new PhononClient({ baseUrl: 'http://127.0.0.1:9' });
  await assert.rejects(down.speech({ input: 'x', deadline: Date.now() + 5000 }), /does not answer/);
});

test('the audio is capped at the size Gladys accepts', async () => {
  reset();
  server.state.framesPerRequest = Math.ceil(MAX_AUDIO_BYTES / 192) + 50;
  const { audio, partial } = await client.speech({ input: 'x', deadline: Date.now() + 20_000 });
  assert.equal(partial, true);
  assert.ok(audio.length <= MAX_AUDIO_BYTES);
  assert.equal(audio.length % 192, 0);
});
