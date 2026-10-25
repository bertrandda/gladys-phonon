// -----------------------------------------------------------------------------
// Phonon TTS: an external integration of type `tts` for Gladys Assistant.
//
// Gladys sends the texts to speak (scene "Play a notification", voice
// assistant) over the integration WebSocket; the `phonon` sub-container
// (ghcr.io/gradium-ai/ptts-openai-server) synthesizes them offline with a
// Phonon model, and the MP3 goes back to Gladys, which serves it to the
// speakers. This file only builds the dependencies and connects: the wiring
// lives in src/integration.js, the engine in src/engine.js.
//
// Environment provided by the Gladys supervisor: GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR (read by the SDK).
// Development overrides: MODELS_DIR (the sub-container volume /models, seen
// from here) and PHONON_URL (the speech server).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { catalog } from './src/catalog.js';
import { createEngine, registerIntegration } from './src/integration.js';

const gladys = new GladysIntegration();

const { engine, gradium } = createEngine({
  gladys,
  logger,
  catalog,
  // The volumes of a sub-container appear in the main container under
  // /data/containers/<name>/<path>.
  modelsDir: process.env.MODELS_DIR || '/data/containers/phonon/models',
  phononUrl: process.env.PHONON_URL || undefined,
});

registerIntegration(gladys, { engine, gradium });

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, shutting down`);
});

logger.info('Starting Phonon TTS...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
