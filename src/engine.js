// -----------------------------------------------------------------------------
// The speech engine: keeps the `phonon` sub-container in line with the
// configuration, and turns texts into MP3 through it.
//
// apply(config), serialized:
//   no model -> nothing runs, Gladys cannot speak (the admin must choose one)
//   model    -> download the checkpoint and the voice into the shared volume
//               (the running server keeps speaking meanwhile), then (re)start
//               the server on the local folder: no network needed afterwards.
// The download happens here, not in the server: progress and Hugging Face
// errors reach the Configuration screen, the token never leaves this
// container, and a failure never crash-loops the sub-container (5 crashes put
// the whole integration in ERROR).
// -----------------------------------------------------------------------------

import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPEECH_RATES } from './config.js';
import { LocalizedError, messagesOf } from './errors.js';
import { checkpointFiles, readConditioners, WEIGHTS } from './hub.js';
import { MODELS, normalizeLanguage, resolveModel } from './models.js';

export const CONTAINER = 'phonon';
// Gladys waits 30 s for a synthesis (TTS_SYNTHESIZE_TIMEOUT_MS): keep a margin
// for the base64 encoding and the WebSocket round trip.
export const SYNTHESIS_DEADLINE_MS = 27_000;
// Where the sub-container sees the shared volume.
export const CONTAINER_MODELS_DIR = '/models';

export const STATUS = {
  UNCONFIGURED: 'unconfigured',
  DOWNLOADING: 'downloading',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
};

const CRASHED_CONTAINER_STATUSES = ['exited', 'dead', 'stopped', 'restarting'];

const NOT_CONFIGURED = {
  en: 'No model selected: choose a Phonon model in the configuration, then save. Gladys cannot speak until then.',
  fr: 'Aucun modèle sélectionné : choisissez un modèle Phonon dans la configuration, puis enregistrez. Gladys ne peut pas parler d’ici là.',
};

// Sentence spoken by the "Test the voice" action when none is given.
const TEST_SENTENCES = {
  fr: 'Bonjour, je suis la voix de Gladys.',
  en: 'Hello, I am the voice of Gladys.',
  de: 'Hallo, ich bin die Stimme von Gladys.',
  es: 'Hola, soy la voz de Gladys.',
  pt: 'Olá, eu sou a voz da Gladys.',
};

const percent = (loaded, total) =>
  total > 0 ? Math.min(100, Math.floor((loaded * 100) / total)) : 0;

/**
 * Join the messages of several parts, each a `{ en, fr }` object.
 * @param {...({ en: string, fr: string }|null|undefined)} parts
 * @returns {{ en: string, fr: string }}
 */
function joinMessages(...parts) {
  const present = parts.filter(Boolean);
  return {
    en: present.map((p) => p.en).join(' '),
    fr: present.map((p) => p.fr).join(' '),
  };
}

export class Engine {
  /**
   * @param {object} options
   * @param {object} options.gladys - The SDK client (setConnectionStatus, *Container).
   * @param {import('./hub.js').Hub} options.hub - Hub bound to the shared volume.
   * @param {import('./voiceStore.js').VoiceStore} options.voiceStore
   * @param {import('./phononClient.js').PhononClient} options.phonon
   * @param {string} options.modelsDir - The shared volume, seen from this container.
   * @param {object} options.logger
   * @param {number} [options.healthTimeoutMs] - How long a (re)start may take.
   * @param {number} [options.pollIntervalMs] - Health polling interval.
   * @param {number} [options.deadlineMs] - Synthesis deadline.
   */
  constructor({
    gladys,
    hub,
    voiceStore,
    phonon,
    modelsDir,
    logger,
    healthTimeoutMs = 3 * 60 * 1000,
    pollIntervalMs = 2000,
    deadlineMs = SYNTHESIS_DEADLINE_MS,
  }) {
    Object.assign(this, { gladys, hub, voiceStore, phonon, modelsDir, logger });
    Object.assign(this, { healthTimeoutMs, pollIntervalMs, deadlineMs });
    this.config = null;
    this.status = STATUS.UNCONFIGURED;
    this.statusMessage = NOT_CONFIGURED;
    // What the running server serves: { envKey, voiceFiles } — null when no
    // server was started by this process, or it was stopped.
    this.serving = null;
    // What synthesize uses: { model, lang, voiceName, voiceLabel } — null
    // while no server is ready.
    this.ready = null;
    this.generation = 0;
    this.applying = Promise.resolve();
    this.queue = Promise.resolve();
    this.warnedLanguages = new Set();
  }

  /**
   * Bring the engine in line with the configuration. Calls are serialized;
   * a newer call supersedes the pending ones.
   * @param {object} config - Normalized config.
   * @param {{ force?: boolean }} [options] - force: restart the server even if
   *   nothing changed (the "Restart the speech engine" action).
   * @returns {Promise<void>}
   */
  apply(config, { force = false } = {}) {
    this.config = config;
    const generation = ++this.generation;
    this.applying = this.applying
      .then(() => this.applyNow(config, generation, force))
      .catch(async (e) => {
        this.logger.error(`Speech engine: ${e.message}`);
        await this.setStatus(STATUS.ERROR, joinMessages(messagesOf(e), this.stillServing()));
      });
    return this.applying;
  }

  /** @returns {boolean} Whether a newer apply() superseded this one. */
  superseded(generation) {
    return generation !== this.generation;
  }

  async applyNow(config, generation, force) {
    if (this.superseded(generation)) {
      return;
    }
    const resolved = resolveModel(config);
    if (resolved === null) {
      await this.stopServer();
      await this.setStatus(STATUS.UNCONFIGURED, NOT_CONFIGURED);
      return;
    }
    if (resolved.error) {
      throw new LocalizedError(resolved.error);
    }
    const { model, lang } = resolved;

    const checkpoint = await this.ensureCheckpoint(model, config, generation);
    if (this.superseded(generation)) {
      return;
    }

    const voiceFilesBefore = await this.voiceStore.files();
    const voice = await this.voiceStore.prepare(config);
    const voiceFiles = await this.voiceStore.files();
    if (this.superseded(generation)) {
      return;
    }

    const warnings = [];
    const env = {
      PTTS_MODEL: `${CONTAINER_MODELS_DIR}/${model.repo}/${checkpoint.sha}`,
      PTTS_LANG: lang,
      PTTS_QUANT: config.quant,
    };
    const rate = SPEECH_RATES[config.speech_rate];
    if (rate !== 0) {
      if (checkpoint.conditioners.includes('duration_delta')) {
        env.PTTS_CONDITION = `duration_delta=${rate}`;
      } else {
        warnings.push({
          en: 'This model has no speech rate setting: the rate is left as is.',
          fr: 'Ce modèle n’a pas de réglage de débit : le débit reste inchangé.',
        });
      }
    }
    const envKey = JSON.stringify(env);
    const voiceChanged = voiceFiles.join('\n') !== voiceFilesBefore.join('\n');
    // A server started earlier may have been restarted meanwhile (Gladys
    // reboot, supervisor): it then needs its model loading time again.
    const unchanged = this.serving?.envKey === envKey && !voiceChanged;
    const healthy = unchanged && (await this.phonon.health());

    if (force || !healthy) {
      // The server speaks the old configuration until here: from now on it is
      // recreated (new env) or restarted (it loads its voices at startup only).
      this.ready = null;
      this.serving = null;
      await this.setStatus(STATUS.LOADING, {
        en: `Starting the speech engine (${model.label})…`,
        fr: `Démarrage du moteur vocal (${model.label})…`,
      });
      if (force) {
        await this.stopServer();
      }
      await this.gladys.startContainer(CONTAINER, { env });
      if (voiceChanged && !force) {
        // Same env: startContainer left the running server alone.
        await this.gladys.restartContainer(CONTAINER);
      }
      await this.waitUntilHealthy(generation);
      if (this.superseded(generation)) {
        return;
      }
      this.serving = { envKey, voiceFiles };
    }

    this.ready = { model, lang, voiceName: voice.name, voiceLabel: voice.label };
    await this.pruneModels(model, checkpoint);
    const voiceText =
      voice.name === null
        ? { en: 'its own voice', fr: 'sa propre voix' }
        : { en: `voice ${voice.label}`, fr: `voix ${voice.label}` };
    await this.setStatus(
      STATUS.READY,
      joinMessages(
        {
          en: `Ready: ${model.label}, ${voiceText.en}.`,
          fr: `Prêt : ${model.label}, ${voiceText.fr}.`,
        },
        ...warnings,
      ),
    );
  }

  /**
   * Download what the checkpoint folder lacks. The first download pins the
   * model to the commit it got (current.json, with the file listing): a model
   * installed once never needs the Hub again, and never changes under the
   * user's feet.
   * @returns {Promise<{ sha: string, weights: string, conditioners: string[] }>}
   */
  async ensureCheckpoint(model, config, generation) {
    const repoDir = join(this.modelsDir, model.repo);
    const currentFile = join(repoDir, 'current.json');
    let info;
    try {
      const current = JSON.parse(await readFile(currentFile, 'utf8'));
      info = { repo: model.repo, sha: current.sha, files: new Map(Object.entries(current.files)) };
    } catch {
      info = await this.hub.resolveRepo(model.repo, { token: this.tokenFor(model, config) });
    }
    const { files, weights } = checkpointFiles(info, config.quant);
    const missing = [];
    for (const file of files) {
      if (!(await this.exists(this.hub.localPath(info, file)))) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      const total = missing.reduce((sum, f) => sum + (info.files.get(f)?.size ?? 0), 0);
      let done = 0;
      let lastPercent = -1;
      let lastReport = 0;
      const report = async (loaded) => {
        const p = percent(done + loaded, total);
        if (p === lastPercent || (p - lastPercent < 5 && Date.now() - lastReport < 10_000)) {
          return;
        }
        lastPercent = p;
        lastReport = Date.now();
        await this.setStatus(STATUS.DOWNLOADING, {
          en: `Downloading ${model.label}: ${p} %${this.ready ? ' (the current voice keeps speaking meanwhile)' : ''}`,
          fr: `Téléchargement de ${model.label} : ${p} %${this.ready ? ' (la voix actuelle continue de parler en attendant)' : ''}`,
        });
      };
      await report(0);
      // config.json first: on a gated model it fails fast without a token.
      for (const file of missing) {
        if (this.superseded(generation)) {
          return { sha: info.sha, weights, conditioners: [] };
        }
        await this.hub.ensureFile(info, file, {
          token: this.tokenFor(model, config),
          onProgress: (loaded) => {
            report(loaded).catch(() => {});
          },
        });
        done += info.files.get(file)?.size ?? 0;
      }
      await writeFile(
        currentFile,
        JSON.stringify({ sha: info.sha, files: Object.fromEntries(info.files) }),
      );
    }
    const conditioners = await readConditioners(this.hub.localPath(info, 'config.json'));
    return { sha: info.sha, weights, conditioners };
  }

  /** The Hugging Face token, for the gated models only (a stale token must not break the others). */
  tokenFor(model, config) {
    return model.gated ? config.hf_token : null;
  }

  async exists(path) {
    return stat(path).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  /**
   * Poll the server until it answers. Its port only opens once the model is
   * loaded. A sub-container that exited is stopped for good (no supervisor
   * restart loop) and reported.
   */
  async waitUntilHealthy(generation) {
    const start = Date.now();
    let startedAt = null;
    while (Date.now() - start < this.healthTimeoutMs) {
      if (this.superseded(generation)) {
        return;
      }
      if (await this.phonon.health()) {
        return;
      }
      // A server that exits is restarted by the supervisor, and 5 crashes put
      // the whole integration in ERROR: stop it at the first sign of a crash.
      const container = (await this.gladys.getContainers()).find((c) => c.name === CONTAINER);
      const restarted =
        startedAt !== null && container?.started_at && container.started_at !== startedAt;
      if (container && (CRASHED_CONTAINER_STATUSES.includes(container.status) || restarted)) {
        await this.stopServer();
        throw new LocalizedError({
          en: 'The speech engine stopped while loading the model: see the logs of the "phonon" container in the Supervision block.',
          fr: 'Le moteur vocal s’est arrêté pendant le chargement du modèle : consultez les journaux du conteneur « phonon » dans le bloc Supervision.',
        });
      }
      startedAt = startedAt ?? container?.started_at ?? null;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new LocalizedError({
      en: 'The speech engine did not start in time: see the logs of the "phonon" container in the Supervision block.',
      fr: 'Le moteur vocal n’a pas démarré à temps : consultez les journaux du conteneur « phonon » dans le bloc Supervision.',
    });
  }

  /** Stop the sub-container if it runs (it then stays stopped). */
  async stopServer() {
    this.ready = null;
    this.serving = null;
    const containers = await this.gladys.getContainers();
    const container = containers.find((c) => c.name === CONTAINER);
    if (container && container.desired !== 'stopped' && container.status !== 'stopped') {
      await this.gladys.stopContainer(CONTAINER);
    }
  }

  /**
   * Keep only the active checkpoint on disk: other models, other commits of
   * this one, and the weights of the other quantization.
   */
  async pruneModels(model, checkpoint) {
    try {
      for (const other of MODELS) {
        if (other.repo !== model.repo) {
          await rm(join(this.modelsDir, other.repo), { recursive: true, force: true });
        }
      }
      const repoDir = join(this.modelsDir, model.repo);
      for (const entry of await readdir(repoDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== checkpoint.sha) {
          await rm(join(repoDir, entry.name), { recursive: true, force: true });
        }
      }
      for (const file of Object.values(WEIGHTS)) {
        if (file !== checkpoint.weights) {
          await rm(join(repoDir, checkpoint.sha, file), { force: true });
        }
      }
      // Catalog voices are moved into the voice folder once downloaded.
      await rm(join(this.modelsDir, this.voiceStore.catalog.repo), {
        recursive: true,
        force: true,
      });
    } catch (e) {
      this.logger.warn(`Could not clean the models folder: ${e.message}`);
    }
  }

  /** The note added to an error while the previous configuration still speaks. */
  stillServing() {
    return this.ready
      ? {
          en: `${this.ready.model.label} keeps speaking meanwhile.`,
          fr: `${this.ready.model.label} continue de parler en attendant.`,
        }
      : null;
  }

  async setStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    this.logger.info(`Speech engine ${status}: ${message.en}`);
    try {
      await this.gladys.setConnectionStatus(status === STATUS.READY, message);
    } catch (e) {
      this.logger.warn(`Could not publish the status: ${e.message}`);
    }
  }

  /**
   * Turn a text into an MP3 data URI for Gladys (`audio/mpeg;base64,...`).
   * Requests run one at a time (the server generates one at a time); each
   * must answer within the deadline counted from its arrival.
   * @param {string} text
   * @param {string|null} [language] - Language of the requesting user.
   * @returns {Promise<string>}
   */
  synthesize(text, language = null) {
    const deadline = Date.now() + this.deadlineMs;
    const run = this.queue.then(() => this.synthesizeNow(text, language, deadline));
    this.queue = run.catch(() => {});
    return run;
  }

  async synthesizeNow(text, language, deadline) {
    const ready = this.ready;
    if (!ready) {
      throw new LocalizedError(
        this.status === STATUS.UNCONFIGURED
          ? NOT_CONFIGURED
          : joinMessages(
              { en: 'Phonon TTS cannot speak yet.', fr: 'Phonon TTS ne peut pas encore parler.' },
              this.statusMessage,
            ),
      );
    }
    const input = typeof text === 'string' ? text.trim() : '';
    if (input === '') {
      throw new LocalizedError({ en: 'Nothing to say.', fr: 'Rien à dire.' });
    }
    if (Date.now() >= deadline) {
      throw new LocalizedError({
        en: 'Too many texts to speak at once: this one waited too long.',
        fr: 'Trop de textes à prononcer en même temps : celui-ci a attendu trop longtemps.',
      });
    }
    const requested = normalizeLanguage(language);
    if (
      requested &&
      !ready.model.languages.includes(requested) &&
      !this.warnedLanguages.has(requested)
    ) {
      this.warnedLanguages.add(requested);
      this.logger.warn(
        `Gladys asked for "${requested}" speech; ${ready.model.label} speaks ${ready.lang}: choose a model in that language for a native voice.`,
      );
    }
    const started = Date.now();
    const { audio, partial } = await this.phonon.speech({
      input,
      voice: ready.voiceName,
      deadline,
    });
    if (partial) {
      this.logger.warn(
        `Text too long to speak within ${this.deadlineMs / 1000} s: only its beginning was synthesized.`,
      );
    }
    this.logger.info(`Synthesized ${input.length} characters in ${Date.now() - started} ms.`);
    return `audio/mpeg;base64,${audio.toString('base64')}`;
  }

  /**
   * The "Test the voice" action: synthesize a sentence and report.
   * @param {string|null} text - Text to speak, or a greeting in the model's language.
   * @returns {Promise<{ en: string, fr: string }>}
   */
  async test(text) {
    const ready = this.ready;
    const sentence = text?.trim() || TEST_SENTENCES[ready?.lang] || TEST_SENTENCES.en;
    const started = Date.now();
    const dataUri = await this.synthesize(sentence, null);
    const elapsed = (Date.now() - started) / 1000;
    const bytes = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64').length;
    // The server encodes a constant 64 kbit/s: 8000 bytes per second of audio.
    const seconds = bytes / 8000;
    const voice = ready.voiceName === null ? null : ready.voiceLabel;
    return {
      en:
        `OK: ${seconds.toFixed(1)} s of speech (${Math.round(bytes / 1024)} KB of MP3) generated in ${elapsed.toFixed(1)} s` +
        ` by ${ready.model.label}${voice ? `, voice ${voice}` : ''}.`,
      fr:
        `OK : ${seconds.toFixed(1).replace('.', ',')} s de parole (${Math.round(bytes / 1024)} Ko de MP3) générées en ${elapsed.toFixed(1).replace('.', ',')} s` +
        ` par ${ready.model.label}${voice ? `, voix ${voice}` : ''}.`,
    };
  }
}
