// -----------------------------------------------------------------------------
// The voice the speech server speaks with.
//
// The server loads every `*.safetensors` of PTTS_VOICE_DIR (/models/voices in
// the sub-container) at startup, named after the file. Only the selected voice
// is kept there: a catalog voice (downloaded from gradium/phonon-voices at the
// commit pinned in voices.catalog.json) or a custom one (Gradium Studio). The
// model's own voice needs no file: the request then names no voice.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalizedError } from './errors.js';
import { VOICE_CUSTOM, VOICE_DEFAULT } from './voiceLabels.js';

const EXTENSION = '.safetensors';

/**
 * The voice a configuration selects, before any download.
 * @param {object} config - Normalized config.
 * @param {{ voices: Array }} catalog - src/voices.catalog.json.
 * @returns {{ kind: 'default' } | { kind: 'catalog', name: string, voice: object } | { kind: 'url', name: string, url: string } | { kind: 'gradium', name: string, id: string }}
 */
export function selectVoice(config, catalog) {
  if (!config.voice || config.voice === VOICE_DEFAULT) {
    return { kind: 'default' };
  }
  if (config.voice === VOICE_CUSTOM) {
    const custom = config.custom_voice;
    if (!custom) {
      throw new LocalizedError({
        en: 'The voice is "Custom voice" but no custom voice is entered: enter a Gradium voice ID or the https URL of a voice file.',
        fr: 'La voix est « Voix personnalisée » mais aucune voix personnalisée n’est renseignée : indiquez un identifiant de voix Gradium ou l’URL https d’un fichier de voix.',
      });
    }
    if (/^https:\/\//i.test(custom)) {
      const hash = createHash('sha256').update(custom).digest('hex').slice(0, 16);
      return { kind: 'url', name: `custom-${hash}`, url: custom };
    }
    if (/^http:\/\//i.test(custom)) {
      throw new LocalizedError({
        en: 'The custom voice URL must use https.',
        fr: 'L’URL de la voix personnalisée doit être en https.',
      });
    }
    return { kind: 'gradium', name: `custom-${custom}`, id: custom };
  }
  const voice = catalog.voices.find((v) => v.voice_id === config.voice);
  if (!voice) {
    throw new LocalizedError({
      en: `Unknown voice "${config.voice}": choose a voice again in the configuration.`,
      fr: `Voix inconnue « ${config.voice} » : choisissez de nouveau une voix dans la configuration.`,
    });
  }
  return { kind: 'catalog', name: voice.voice_id, voice };
}

/**
 * Keeps the voice folder in sync with the configuration.
 */
export class VoiceStore {
  /**
   * @param {object} options
   * @param {string} options.dir - The voice folder (PTTS_VOICE_DIR, seen from this container).
   * @param {{ repo: string, sha: string, voices: Array }} options.catalog
   * @param {import('./hub.js').Hub} options.hub
   * @param {import('./gradium.js').Gradium} options.gradium
   */
  constructor({ dir, catalog, hub, gradium }) {
    this.dir = dir;
    this.catalog = catalog;
    this.hub = hub;
    this.gradium = gradium;
  }

  /** @returns {Promise<string[]>} The voice files in the folder, sorted. */
  async files() {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith(EXTENSION)).sort();
    } catch (e) {
      if (e.code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }

  /**
   * Put the selected voice (and only it) in the voice folder, downloading it
   * if needed. On failure the folder is left as it was.
   * @param {object} config - Normalized config.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ name: string|null, label: string }>} `name`: the voice
   *   to request (`null` for the model's own voice); `label`: for the status.
   */
  async prepare(config, { signal } = {}) {
    const selection = selectVoice(config, this.catalog);
    await mkdir(this.dir, { recursive: true });
    if (selection.kind !== 'default') {
      const target = join(this.dir, `${selection.name}${EXTENSION}`);
      const exists = await stat(target).then(
        (s) => s.isFile() && s.size > 0,
        () => false,
      );
      if (!exists) {
        await this.download(selection, target, { signal, apiKey: config.gradium_api_key });
      }
    }
    const keep = selection.kind === 'default' ? null : `${selection.name}${EXTENSION}`;
    for (const file of await this.files()) {
      if (file !== keep) {
        await rm(join(this.dir, file), { force: true });
      }
    }
    return {
      name: selection.kind === 'default' ? null : selection.name,
      label:
        selection.kind === 'catalog'
          ? selection.voice.name
          : selection.kind === 'default'
            ? 'default'
            : config.custom_voice,
    };
  }

  async download(selection, target, { signal, apiKey }) {
    if (selection.kind === 'catalog') {
      const { voice } = selection;
      const info = {
        repo: this.catalog.repo,
        sha: this.catalog.sha,
        files: new Map([
          [voice.filename, { size: voice.size ?? undefined, sha256: voice.sha256 ?? undefined }],
        ]),
      };
      const cached = await this.hub.ensureFile(info, voice.filename, { signal });
      // The hub keeps the file under <repo>/<sha>/: move it into the voice
      // folder, so a voice never chosen again does not stay on disk.
      await rename(cached, target);
      return;
    }
    const buffer =
      selection.kind === 'url'
        ? await this.gradium.downloadVoiceUrl(selection.url)
        : await this.gradium.downloadVoice(apiKey, selection.id);
    const part = `${target}.part`;
    await writeFile(part, buffer);
    await rename(part, target);
  }
}
