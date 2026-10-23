// -----------------------------------------------------------------------------
// Local fakes of the services the integration talks to, on 127.0.0.1 (the
// tests never touch the network): the Hugging Face Hub, the speech server
// (ptts-openai-server) and the Gradium API.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * One MPEG-2 Layer III frame as LAME writes the speech server's audio: mono,
 * 24 kHz, 64 kbit/s, no CRC -> 72 * 64000 / 24000 = 192 bytes.
 * @param {number} [fill] - Byte filling the frame payload.
 * @returns {Buffer}
 */
export function mp3Frame(fill = 0x55) {
  const frame = Buffer.alloc(192, fill);
  frame.set([0xff, 0xf3, 0x84, 0xc0], 0);
  return frame;
}

/** A fake .safetensors voice file (8-byte header length + JSON header). */
export function voiceFile(tag = 'voice') {
  const header = Buffer.from(JSON.stringify({ __metadata__: { tag } }));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(64, 1)]);
}

async function listen(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fake Hub. `repos`: `{ 'owner/name': { sha, gated, files: { path: Buffer } } }`.
 * A gated repo serves its files only with `Authorization: Bearer good-token`
 * (401 without a token, 403 with another one); its listing is public, like on
 * the real Hub.
 */
export async function startFakeHub(repos) {
  const requests = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub');
    requests.push({ path: url.pathname, authorization: req.headers.authorization ?? null });
    const api = /^\/api\/models\/([^/]+\/[^/]+)\/revision\/([^/]+)$/.exec(url.pathname);
    if (api) {
      const repo = repos[api[1]];
      if (!repo) {
        res.statusCode = 404;
        return res.end('{}');
      }
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          sha: repo.sha,
          gated: repo.gated ? 'auto' : false,
          siblings: Object.entries(repo.files).map(([rfilename, data]) => ({
            rfilename,
            size: data.length,
            lfs: { sha256: createHash('sha256').update(data).digest('hex'), size: data.length },
          })),
        }),
      );
    }
    const file = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
    const repo = file && repos[file[1]];
    if (!repo || file[2] !== repo.sha || !repo.files[decodeURIComponent(file[3])]) {
      res.statusCode = 404;
      return res.end();
    }
    if (repo.gated && req.headers.authorization !== 'Bearer good-token') {
      res.statusCode = req.headers.authorization ? 403 : 401;
      return res.end();
    }
    const data = repo.files[decodeURIComponent(file[3])];
    res.setHeader('content-length', data.length);
    return res.end(data);
  });
  return { ...server, requests };
}

/**
 * Fake speech server. `framesPerRequest` frames are streamed `frameDelayMs`
 * apart; `healthy` can be flipped by the test.
 */
export async function startFakePhonon({
  framesPerRequest = 10,
  frameDelayMs = 0,
  voices = [],
} = {}) {
  const state = { healthy: true, requests: [], voices, framesPerRequest, frameDelayMs };
  const server = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://phonon');
    if (url.pathname === '/health') {
      res.statusCode = state.healthy ? 200 : 503;
      return res.end('{"status":"ok"}');
    }
    if (url.pathname === '/v1/audio/voices') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ voices: state.voices, aliases: {} }));
    }
    if (url.pathname === '/v1/audio/speech' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      state.requests.push(body);
      if (body.voice && !state.voices.includes(body.voice)) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: { message: `unknown voice '${body.voice}'` } }));
      }
      res.setHeader('content-type', 'audio/mpeg');
      for (let i = 0; i < state.framesPerRequest; i += 1) {
        if (res.destroyed) return undefined;
        res.write(mp3Frame());
        if (state.frameDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.frameDelayMs));
        }
      }
      return res.end();
    }
    res.statusCode = 404;
    return res.end();
  });
  return { ...server, state };
}

/**
 * Fake Gradium API: `voices` of the account `{ uid, name, language }`, keyed
 * by API key `good-key`.
 */
export async function startFakeGradium({ voices = [] } = {}) {
  const requests = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://gradium');
    requests.push({ path: url.pathname, key: req.headers['x-api-key'] ?? null });
    if (req.headers['x-api-key'] !== 'good-key') {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ detail: 'Invalid API key' }));
    }
    if (url.pathname === '/api/voices/') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(voices));
    }
    const blob = /^\/api\/voices\/embeddings\/([^/]+)\/default\/blob$/.exec(url.pathname);
    if (blob && voices.some((v) => v.uid === blob[1])) {
      return res.end(voiceFile(blob[1]));
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ detail: 'Not found' }));
  });
  return { ...server, requests };
}

/** A logger that records instead of printing. */
export function silentLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push({ level, text: args.join(' ') });
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
