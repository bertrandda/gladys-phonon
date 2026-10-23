// -----------------------------------------------------------------------------
// Hugging Face Hub access: resolves a repo to a commit, downloads its files
// into the shared models volume, and reads a checkpoint's config.
//
// Ported from the server of https://github.com/bertrandda/phonon-demo
// (server/hub.ts). The files are laid out as `<modelsDir>/<repo>/<sha>/<file>`,
// a plain checkpoint folder the speech server loads with PTTS_MODEL: once the
// files are on disk, nothing needs the network any more.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalizedError } from './errors.js';

export const HUB_URL = 'https://huggingface.co';

// Weights file of each quantization, as the native frontends pick them
// (ptts `checkpoint::weight_candidates`): the preferred one, then the other.
export const WEIGHTS = { q8: 'model.q8.gguf', f32: 'model.safetensors' };
export const DEFAULT_VOICE_FILE = 'default-voice.safetensors';
// Voice embeddings a checkpoint may ship (ptts `loader::VOICE_DIRS`).
const VOICE_DIRS = ['voices', 'embeddings'];

function accessDenied(repo, status, hasToken) {
  const page = `${HUB_URL}/${repo}`;
  if (!hasToken) {
    return new LocalizedError(
      {
        en: `${repo} is a gated model: accept its terms on ${page}, then enter a Hugging Face token in the configuration.`,
        fr: `${repo} est un modèle à accès restreint : acceptez ses conditions sur ${page}, puis renseignez un token Hugging Face dans la configuration.`,
      },
      { status },
    );
  }
  if (status === 401) {
    return new LocalizedError(
      {
        en: 'Hugging Face refused the token: check the token entered in the configuration.',
        fr: 'Hugging Face a refusé le token : vérifiez le token renseigné dans la configuration.',
      },
      { status },
    );
  }
  return new LocalizedError(
    {
      en: `Access to ${repo} denied: accept its terms on ${page} with the account of the token.`,
      fr: `Accès à ${repo} refusé : acceptez ses conditions sur ${page} avec le compte du token.`,
    },
    { status },
  );
}

function unreachable(what, cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new LocalizedError(
    {
      en: `Cannot reach Hugging Face to download ${what} (${reason}). Check the internet access of Gladys, then use "Restart the speech engine".`,
      fr: `Impossible de joindre Hugging Face pour télécharger ${what} (${reason}). Vérifiez l'accès Internet de Gladys, puis utilisez « Relancer le moteur vocal ».`,
    },
    { cause },
  );
}

async function isFile(path) {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/**
 * Hub client bound to a models folder.
 */
export class Hub {
  /**
   * @param {object} options
   * @param {string} options.modelsDir - Where the files go (the shared volume).
   * @param {typeof fetch} [options.fetch] - fetch implementation (tests inject one).
   * @param {string} [options.hubUrl] - Hub base URL.
   */
  constructor({ modelsDir, fetch: fetchImpl = globalThis.fetch, hubUrl = HUB_URL }) {
    this.modelsDir = modelsDir;
    this.fetch = fetchImpl;
    this.hubUrl = hubUrl;
  }

  /**
   * The commit `revision` of `repo` points at, and its files with their sizes.
   * Falls back to the last answer saved on disk when the Hub is unreachable,
   * so an installed model starts offline.
   * @param {string} repo - e.g. `gradium/phonon-40m-fr`.
   * @param {{ revision?: string, token?: string|null }} [options]
   * @returns {Promise<{ repo: string, sha: string, gated: boolean, files: Map<string, { size?: number, sha256?: string }> }>}
   */
  async resolveRepo(repo, { revision = 'main', token = null } = {}) {
    const cacheFile = join(this.modelsDir, repo, `revision-${revision}.json`);
    let raw;
    try {
      const response = await this.fetch(
        `${this.hubUrl}/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (response.status === 401 || response.status === 403) {
        throw accessDenied(repo, response.status, Boolean(token));
      }
      if (response.status === 404) {
        throw new LocalizedError(
          {
            en: `${repo}@${revision} does not exist on Hugging Face.`,
            fr: `${repo}@${revision} n'existe pas sur Hugging Face.`,
          },
          { status: 404 },
        );
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      raw = await response.json();
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(raw));
    } catch (e) {
      if (e instanceof LocalizedError) {
        throw e;
      }
      try {
        raw = JSON.parse(await readFile(cacheFile, 'utf8'));
      } catch {
        throw unreachable(repo, e);
      }
    }
    const files = new Map(
      (raw.siblings ?? []).map((s) => [s.rfilename, { size: s.size, sha256: s.lfs?.sha256 }]),
    );
    return { repo, sha: raw.sha, gated: Boolean(raw.gated), files };
  }

  /**
   * Local path of a file of a resolved repo.
   * @param {{ repo: string, sha: string }} info
   * @param {string} file
   * @returns {string}
   */
  localPath(info, file) {
    return join(this.modelsDir, info.repo, info.sha, file);
  }

  /**
   * The local path of `file`, downloading it first if needed. A download goes
   * to a `.part` file renamed once complete and checked (size, and sha256 for
   * the large files), so an interrupted one never passes for a model file.
   * @param {object} info - Result of resolveRepo.
   * @param {string} file - Path of the file in the repo.
   * @param {object} [options]
   * @param {string|null} [options.token] - Hugging Face token (gated repos).
   * @param {(loaded: number) => void} [options.onProgress] - Bytes received so far.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>}
   */
  async ensureFile(info, file, { token = null, onProgress, signal } = {}) {
    const meta = info.files.get(file);
    if (!meta) {
      throw new LocalizedError({
        en: `${info.repo} has no file ${file}.`,
        fr: `${info.repo} ne contient pas de fichier ${file}.`,
      });
    }
    const path = this.localPath(info, file);
    if (await isFile(path)) {
      return path;
    }
    const url = `${this.hubUrl}/${info.repo}/resolve/${info.sha}/${file.split('/').map(encodeURIComponent).join('/')}`;
    let response;
    try {
      response = await this.fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal,
      });
    } catch (e) {
      if (signal?.aborted) {
        throw e;
      }
      throw unreachable(`${info.repo}/${file}`, e);
    }
    if (response.status === 401 || response.status === 403) {
      throw accessDenied(info.repo, response.status, Boolean(token));
    }
    if (!response.ok || !response.body) {
      throw unreachable(`${info.repo}/${file}`, new Error(`HTTP ${response.status}`));
    }

    await mkdir(dirname(path), { recursive: true });
    const part = `${path}.part`;
    const hash = createHash('sha256');
    let loaded = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        loaded += chunk.length;
        hash.update(chunk);
        onProgress?.(loaded);
        callback(null, chunk);
      },
    });
    const corrupted = (reason) =>
      new LocalizedError({
        en: `The download of ${info.repo}/${file} is corrupted (${reason}): use "Restart the speech engine" to download it again.`,
        fr: `Le téléchargement de ${info.repo}/${file} est corrompu (${reason}) : utilisez « Relancer le moteur vocal » pour le télécharger de nouveau.`,
      });
    try {
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part), { signal });
      if (meta.size !== undefined && loaded !== meta.size) {
        throw corrupted(`${loaded} bytes received, ${meta.size} expected`);
      }
      if (meta.sha256 && hash.digest('hex') !== meta.sha256) {
        throw corrupted('checksum mismatch');
      }
      await rename(part, path);
    } catch (e) {
      await rm(part, { force: true });
      if (signal?.aborted || e instanceof LocalizedError) {
        throw e;
      }
      throw unreachable(`${info.repo}/${file}`, e);
    }
    return path;
  }
}

/**
 * The files of a checkpoint the speech server loads from a folder: config,
 * tokenizer, the weights of the quantization (or the other one if the repo
 * lacks them), the default voice and the voices shipped with the checkpoint.
 * @param {{ files: Map<string, object> }} info - Result of resolveRepo.
 * @param {'q8'|'f32'} quant
 * @returns {{ files: string[], weights: string }}
 */
export function checkpointFiles(info, quant) {
  const candidates = quant === 'f32' ? [WEIGHTS.f32, WEIGHTS.q8] : [WEIGHTS.q8, WEIGHTS.f32];
  const weights = candidates.find((name) => info.files.has(name));
  if (!weights) {
    throw new LocalizedError({
      en: `${info.repo} has no weights (${candidates.join(', ')}).`,
      fr: `${info.repo} ne contient pas de poids (${candidates.join(', ')}).`,
    });
  }
  const voices = [...info.files.keys()].filter((file) => {
    const [dir, name, ...rest] = file.split('/');
    return VOICE_DIRS.includes(dir) && rest.length === 0 && name?.endsWith('.safetensors');
  });
  const files = ['config.json', 'tokenizer.json', weights, ...voices];
  if (info.files.has(DEFAULT_VOICE_FILE)) {
    files.push(DEFAULT_VOICE_FILE);
  }
  return { files, weights };
}

/**
 * Conditioner names of a checkpoint config (`num_speakers`, `duration_delta`…).
 * @param {string} configPath - Local path of its config.json.
 * @returns {Promise<string[]>}
 */
export async function readConditioners(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return (config.conditioners ?? []).map((c) => c.name).filter(Boolean);
}
