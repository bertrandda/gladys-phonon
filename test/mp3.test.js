import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameLength, trimToLastFrame } from '../src/mp3.js';
import { mp3Frame } from './helpers/fakeServers.js';

test('frameLength reads the speech server frames (MPEG-2 Layer III, 24 kHz, 64 kbit/s)', () => {
  assert.equal(frameLength(mp3Frame(), 0), 192);
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, padded: 144 * 128000 / 44100 + 1.
  assert.equal(frameLength(Buffer.from([0xff, 0xfb, 0x92, 0x00]), 0), 418);
  assert.equal(frameLength(Buffer.from([0x00, 0xf3, 0x84, 0xc0]), 0), 0);
  assert.equal(frameLength(Buffer.from([0xff, 0xf3]), 0), 0);
});

test('trimToLastFrame keeps the complete frames only', () => {
  const three = Buffer.concat([mp3Frame(), mp3Frame(), mp3Frame()]);
  assert.equal(trimToLastFrame(three).length, 576);
  assert.equal(trimToLastFrame(three.subarray(0, 500)).length, 384);
  assert.equal(trimToLastFrame(three.subarray(0, 100)).length, 0);
  assert.equal(trimToLastFrame(Buffer.alloc(0)).length, 0);
});

test('trimToLastFrame skips an ID3v2 tag', () => {
  const tag = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([4, 0, 0, 0, 0, 0, 10]),
    Buffer.alloc(10),
  ]);
  const audio = Buffer.concat([tag, mp3Frame(), mp3Frame().subarray(0, 50)]);
  assert.equal(trimToLastFrame(audio).length, tag.length + 192);
  assert.equal(trimToLastFrame(tag).length, 0);
});
