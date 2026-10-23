// -----------------------------------------------------------------------------
// Integration configuration, filled in by the administrator from the
// `config_schema` of gladys-assistant-integration.json. The SDK fetches it
// (`gladys.config`) and pushes every change (`onConfigUpdated`).
//
// This module only provides the defaults and normalizes the received object,
// so the rest of the code never deals with `undefined` or empty strings.
// -----------------------------------------------------------------------------

import { VOICE_CUSTOM, VOICE_DEFAULT } from './voiceLabels.js';

export { VOICE_CUSTOM, VOICE_DEFAULT };

// Defaults: they MUST stay consistent with the `default` values of the
// manifest (test/manifest.test.js). `model` has none on purpose: nothing is
// downloaded and Gladys cannot speak until the administrator chooses one.
export const DEFAULT_CONFIG = {
  model: null,
  language: null,
  hf_token: null,
  voice: VOICE_DEFAULT,
  custom_voice: null,
  gradium_api_key: null,
  speech_rate: 'normal',
  quant: 'q8',
};

// `duration_delta` conditioner of the checkpoints: negative speaks faster,
// positive slower; small values work best (ptts docs/cli.md).
export const SPEECH_RATES = { slower: 0.3, normal: 0, faster: -0.3 };

export const QUANTS = ['q8', 'f32'];

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Merge the configuration received from Gladys with the defaults.
 * @param {Record<string, unknown>} [raw] - Config as returned by the SDK.
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw = {}) {
  return {
    model: text(raw.model),
    language: text(raw.language),
    hf_token: text(raw.hf_token),
    voice: text(raw.voice) ?? DEFAULT_CONFIG.voice,
    custom_voice: text(raw.custom_voice),
    gradium_api_key: text(raw.gradium_api_key),
    speech_rate: Object.hasOwn(SPEECH_RATES, raw.speech_rate)
      ? raw.speech_rate
      : DEFAULT_CONFIG.speech_rate,
    quant: QUANTS.includes(raw.quant) ? raw.quant : DEFAULT_CONFIG.quant,
  };
}
