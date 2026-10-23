// -----------------------------------------------------------------------------
// HTTP client of the speech server (ptts-openai-server, the `phonon`
// sub-container), reached by its DNS alias on the private network of the
// integration. OpenAI-compatible API: POST /v1/audio/speech streams the audio
// as it is generated, which lets a synthesis that runs late hand back the
// speech produced so far.
// -----------------------------------------------------------------------------

import { LocalizedError } from './errors.js';
import { trimToLastFrame } from './mp3.js';

export const DEFAULT_PHONON_URL = 'http://phonon:8880';
// Decoded audio Gladys accepts from a TTS provider (MAX_TTS_AUDIO_SIZE_BYTES).
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const timeoutError = () =>
  new LocalizedError({
    en: 'The speech engine took too long to speak this text.',
    fr: 'Le moteur vocal a mis trop de temps à prononcer ce texte.',
  });

async function serverError(response) {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    message = body?.error?.message ?? message;
  } catch {
    // not the OpenAI error shape
  }
  if (response.status === 429) {
    return new LocalizedError(
      {
        en: 'The speech engine is busy, try again in a moment.',
        fr: 'Le moteur vocal est occupé, réessayez dans un instant.',
      },
      { status: 429 },
    );
  }
  return new LocalizedError(
    {
      en: `The speech engine refused the request: ${message}`,
      fr: `Le moteur vocal a refusé la demande : ${message}`,
    },
    { status: response.status },
  );
}

export class PhononClient {
  /**
   * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
   */
  constructor({ baseUrl = DEFAULT_PHONON_URL, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  /**
   * Whether the server answers. Its port only opens once the model is loaded.
   * @returns {Promise<boolean>}
   */
  async health() {
    try {
      const response = await this.fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The voices the server loaded.
   * @returns {Promise<string[]>}
   */
  async voices() {
    const response = await this.fetch(`${this.baseUrl}/v1/audio/voices`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw await serverError(response);
    }
    const body = await response.json();
    return Array.isArray(body.voices) ? body.voices : [];
  }

  /**
   * Synthesize `input` as MP3. When `deadline` comes while the audio is still
   * streaming, the request is cut and the complete frames received so far are
   * returned (`partial: true`) — Gladys rather speaks the beginning of a long
   * text than nothing.
   * @param {object} options
   * @param {string} options.input - Text to speak.
   * @param {string|null} [options.voice] - Server voice name; null: the model's own voice.
   * @param {number} options.deadline - Epoch milliseconds.
   * @returns {Promise<{ audio: Buffer, partial: boolean }>}
   */
  async speech({ input, voice = null, deadline }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input, response_format: 'mp3', ...(voice ? { voice } : {}) }),
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          throw timeoutError();
        }
        throw new LocalizedError(
          {
            en: `The speech engine does not answer (${e.message}).`,
            fr: `Le moteur vocal ne répond pas (${e.message}).`,
          },
          { cause: e },
        );
      }
      if (!response.ok) {
        throw await serverError(response);
      }

      const chunks = [];
      let size = 0;
      let partial = false;
      try {
        for await (const chunk of response.body) {
          chunks.push(Buffer.from(chunk));
          size += chunk.length;
          if (size >= MAX_AUDIO_BYTES) {
            partial = true;
            controller.abort();
            break;
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          throw e;
        }
        partial = true;
      }
      let audio = Buffer.concat(chunks);
      if (partial) {
        audio = trimToLastFrame(audio.subarray(0, MAX_AUDIO_BYTES));
        if (audio.length === 0) {
          throw timeoutError();
        }
      }
      return { audio, partial };
    } finally {
      clearTimeout(timer);
    }
  }
}
