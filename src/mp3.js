// -----------------------------------------------------------------------------
// MP3 helpers. The speech server streams MP3 (LAME, MPEG Layer III); when a
// long text runs into the deadline Gladys gives a synthesis, the stream is cut
// and the audio received so far is used. Cutting at a frame boundary keeps the
// partial clip clean for picky players (Sonos, Cast).
// -----------------------------------------------------------------------------

// Layer III bitrates (kbit/s) by bitrate index: MPEG-1, then MPEG-2 and 2.5.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// Sample rates (Hz) by version bits (0: MPEG-2.5, 2: MPEG-2, 3: MPEG-1).
const SAMPLE_RATES = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

/**
 * Length in bytes of the Layer III frame whose header starts at `offset`, or
 * 0 when there is no valid header there.
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {number}
 */
export function frameLength(buffer, offset) {
  if (offset + 4 > buffer.length) return 0;
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  if (buffer[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    rateIndex === 3
  ) {
    return 0;
  }
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
}

/**
 * Size of an ID3v2 tag at the start of the buffer (0 when there is none).
 * @param {Buffer} buffer
 * @returns {number}
 */
function id3Size(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  return 10 + size;
}

/**
 * The longest prefix of `buffer` made of complete MP3 frames (an empty buffer
 * when no complete frame was received).
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function trimToLastFrame(buffer) {
  let offset = id3Size(buffer);
  let end = offset;
  for (;;) {
    const length = frameLength(buffer, offset);
    if (length === 0 || offset + length > buffer.length) break;
    offset += length;
    end = offset;
  }
  return end === id3Size(buffer) ? buffer.subarray(0, 0) : buffer.subarray(0, end);
}
