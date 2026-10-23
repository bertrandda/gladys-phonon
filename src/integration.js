// -----------------------------------------------------------------------------
// Wiring of the integration on the SDK client: the TTS provider command, the
// configuration and the actions of the Configuration screen. index.js builds
// the real dependencies; the tests pass the SDK's fake Gladys and fakes.
// -----------------------------------------------------------------------------

import { join } from 'node:path';
import { normalizeConfig } from './config.js';
import { Engine } from './engine.js';
import { Gradium } from './gradium.js';
import { Hub } from './hub.js';
import { PhononClient } from './phononClient.js';
import { onTtsSynthesize } from './ttsShim.js';
import { VoiceStore } from './voiceStore.js';

/**
 * Build the engine and its dependencies.
 * @param {object} options
 * @param {object} options.gladys - SDK client.
 * @param {object} options.logger
 * @param {object} options.catalog - src/voices.catalog.json.
 * @param {string} options.modelsDir - The `phonon` sub-container volume /models, seen from here.
 * @param {string} [options.phononUrl]
 * @param {typeof fetch} [options.fetch]
 * @param {object} [options.engineOptions] - Timing overrides (tests).
 * @returns {{ engine: Engine, gradium: Gradium }}
 */
export function createEngine({
  gladys,
  logger,
  catalog,
  modelsDir,
  phononUrl,
  fetch: fetchImpl = globalThis.fetch,
  hubUrl,
  gradiumUrl,
  engineOptions = {},
}) {
  const hub = new Hub({ modelsDir, fetch: fetchImpl, ...(hubUrl ? { hubUrl } : {}) });
  const gradium = new Gradium({ fetch: fetchImpl, ...(gradiumUrl ? { apiUrl: gradiumUrl } : {}) });
  const voiceStore = new VoiceStore({ dir: join(modelsDir, 'voices'), catalog, hub, gradium });
  const phonon = new PhononClient({
    fetch: fetchImpl,
    ...(phononUrl ? { baseUrl: phononUrl } : {}),
  });
  const engine = new Engine({
    gladys,
    hub,
    voiceStore,
    phonon,
    modelsDir,
    logger,
    ...engineOptions,
  });
  return { engine, gradium };
}

/**
 * Register every handler on the SDK client. Call before gladys.connect().
 * @param {object} gladys - SDK client.
 * @param {{ engine: Engine, gradium: Gradium, logger: object }} deps
 */
export function registerIntegration(gladys, { engine, gradium, logger }) {
  const config = () => normalizeConfig(gladys.config);

  // Gladys asks for speech: scene "Play a notification", voice assistant.
  const mechanism = onTtsSynthesize(gladys, (text, language) => engine.synthesize(text, language));
  logger.debug(`tts.synthesize handled by the ${mechanism}`);

  // The administrator saved the configuration. Not awaited: a model download
  // can take minutes, its progress shows in the connection status.
  gladys.onConfigUpdated(async (newConfig) => {
    engine.apply(normalizeConfig(newConfig));
  });

  // Every (re)connection: the SDK has just re-read the configuration (a change
  // made while disconnected is lost otherwise), and Gladys forgot the
  // connection status if it restarted.
  gladys.on('connected', () => {
    engine.apply(config());
  });

  gladys.onAction('test_voice', async (fields) => engine.test(fields?.text ?? null));

  gladys.onAction('list_gradium_voices', async () => {
    const voices = await gradium.listVoices(config().gradium_api_key);
    if (voices.length === 0) {
      return {
        en: 'Your Gradium account has no voice yet: design or clone one in Gradium Studio.',
        fr: 'Votre compte Gradium n’a pas encore de voix : créez-en ou clonez-en une dans Gradium Studio.',
      };
    }
    const lines = voices.map((v) =>
      [v.uid, v.language || '--', v.name].filter((part) => part !== undefined).join(' · '),
    );
    return {
      en: `Copy an ID into "Custom voice":\n${lines.join('\n')}`,
      fr: `Copiez un identifiant dans « Voix personnalisée » :\n${lines.join('\n')}`,
    };
  });

  gladys.onAction('restart_engine', async () => {
    // Not awaited either: the result shows in the status at the top.
    engine.apply(config(), { force: true });
    return {
      en: 'Restarting the speech engine: follow its status at the top of this page.',
      fr: 'Relance du moteur vocal : suivez son état en haut de cette page.',
    };
  });
}
