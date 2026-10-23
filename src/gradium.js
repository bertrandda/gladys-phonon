// -----------------------------------------------------------------------------
// Gradium API: the custom voices designed or cloned in Gradium Studio.
//
// A Phonon voice is a small speaker embedding (.safetensors). The API hands
// out the embedding of any voice of the account, for every Phonon checkpoint
// (`default` model), as xn-ptts/scripts/download-voice.py does it.
// -----------------------------------------------------------------------------

import { LocalizedError } from './errors.js';

export const GRADIUM_API_URL = 'https://api.gradium.ai/api';
// A voice embedding weighs ~250 KB: anything far bigger is not one.
export const MAX_VOICE_FILE_SIZE = 5 * 1024 * 1024;
export const GRADIUM_VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

const missingKey = () =>
  new LocalizedError({
    en: 'A custom voice given by its ID needs the Gradium API key: enter it in the configuration.',
    fr: 'Une voix personnalisée donnée par son identifiant nécessite la clé API Gradium : renseignez-la dans la configuration.',
  });

async function apiError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
  } catch {
    // no JSON body
  }
  if (response.status === 401 || response.status === 403) {
    return new LocalizedError(
      {
        en: 'Gradium refused the API key: check the key entered in the configuration.',
        fr: 'Gradium a refusé la clé API : vérifiez la clé renseignée dans la configuration.',
      },
      { status: response.status },
    );
  }
  if (response.status === 404) {
    return new LocalizedError(
      {
        en: 'Unknown Gradium voice: check the ID of the custom voice ("List my Gradium Studio voices" shows them).',
        fr: 'Voix Gradium inconnue : vérifiez l’identifiant de la voix personnalisée (« Lister mes voix Gradium Studio » les affiche).',
      },
      { status: 404 },
    );
  }
  const suffix = detail ? `: ${detail}` : '';
  return new LocalizedError(
    {
      en: `Gradium API error ${response.status}${suffix}`,
      fr: `Erreur ${response.status} de l’API Gradium${suffix}`,
    },
    { status: response.status },
  );
}

function unreachable(cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new LocalizedError(
    {
      en: `Cannot reach the Gradium API (${reason}).`,
      fr: `Impossible de joindre l’API Gradium (${reason}).`,
    },
    { cause },
  );
}

/**
 * Check the first bytes of a .safetensors file: an 8-byte little-endian header
 * length, then a JSON header.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function looksLikeSafetensors(buffer) {
  if (buffer.length < 10) {
    return false;
  }
  const headerLength = Number(buffer.readBigUInt64LE(0));
  return headerLength > 1 && headerLength < buffer.length && buffer[8] === 0x7b; // '{'
}

/**
 * Read a response body, refusing more than MAX_VOICE_FILE_SIZE bytes.
 * @param {Response} response
 * @returns {Promise<Buffer>}
 */
async function readVoiceFile(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_VOICE_FILE_SIZE) {
    throw new Error(`voice file too large (${declared} bytes)`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_VOICE_FILE_SIZE) {
      throw new Error('voice file too large');
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (!looksLikeSafetensors(buffer)) {
    throw new LocalizedError({
      en: 'The custom voice is not a Phonon voice file (.safetensors).',
      fr: 'La voix personnalisée n’est pas un fichier de voix Phonon (.safetensors).',
    });
  }
  return buffer;
}

/**
 * Gradium API client.
 */
export class Gradium {
  /**
   * @param {{ fetch?: typeof fetch, apiUrl?: string }} [options]
   */
  constructor({ fetch: fetchImpl = globalThis.fetch, apiUrl = GRADIUM_API_URL } = {}) {
    this.fetch = fetchImpl;
    this.apiUrl = apiUrl;
  }

  async request(path, apiKey) {
    if (!apiKey) {
      throw missingKey();
    }
    let response;
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw unreachable(e);
    }
    if (!response.ok) {
      throw await apiError(response);
    }
    return response;
  }

  /**
   * The voices of the account.
   * @param {string|null} apiKey
   * @returns {Promise<Array<{ uid: string, name: string, language?: string|null, description?: string|null }>>}
   */
  async listVoices(apiKey) {
    const response = await this.request('/voices/?limit=0', apiKey);
    const voices = await response.json();
    return Array.isArray(voices) ? voices : [];
  }

  /**
   * The Phonon voice file of a voice of the account.
   * @param {string|null} apiKey
   * @param {string} voiceId
   * @returns {Promise<Buffer>}
   */
  async downloadVoice(apiKey, voiceId) {
    if (!GRADIUM_VOICE_ID_PATTERN.test(voiceId)) {
      throw new LocalizedError({
        en: `"${voiceId}" is not a Gradium voice ID nor an https URL.`,
        fr: `« ${voiceId} » n’est ni un identifiant de voix Gradium ni une URL https.`,
      });
    }
    const response = await this.request(
      `/voices/embeddings/${encodeURIComponent(voiceId)}/default/blob?as_safetensors=1`,
      apiKey,
    );
    return readVoiceFile(response);
  }

  /**
   * A Phonon voice file published at an https URL.
   * @param {string} url
   * @returns {Promise<Buffer>}
   */
  async downloadVoiceUrl(url) {
    let response;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new LocalizedError(
        {
          en: `Cannot download the custom voice from ${url} (${e.message}).`,
          fr: `Impossible de télécharger la voix personnalisée depuis ${url} (${e.message}).`,
        },
        { cause: e },
      );
    }
    if (!response.ok || !response.body) {
      throw new LocalizedError({
        en: `Cannot download the custom voice from ${url} (HTTP ${response.status}).`,
        fr: `Impossible de télécharger la voix personnalisée depuis ${url} (HTTP ${response.status}).`,
      });
    }
    return readVoiceFile(response);
  }
}
