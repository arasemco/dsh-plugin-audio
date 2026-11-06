/**
 * dsh-plugin-audio — the inventory component (`audio-status`).
 *
 * The row that makes the bundle's component structure visible and testable:
 *
 *   GET  /audio/status → the components currently mounted, and what discovery
 *                        has learned so far without triggering a probe
 *   POST /audio/echo   → speak a sentence with the read-aloud engine, then
 *                        transcribe it back; the bundle testing itself
 *
 * Both routes work off the `audioProtocol` service, so they exist whenever this
 * row does — independently of whether the `tts` and `stt` route rows are on.
 */

import { readFile } from 'node:fs/promises'

/** This package's own manifest, so the inventory reports the installed version. */
const MANIFEST = new URL('../package.json', import.meta.url)

/** Loaded once: the package name and version this bundle reports. */
let identity

/**
 * Read this package's manifest.
 * @returns The parsed `package.json`, or an empty object when it cannot be read.
 */
async function whoami () {
  if (identity !== undefined) return identity
  try {
    identity = JSON.parse(await readFile(MANIFEST, 'utf8'))
  } catch {
    identity = {}
  }
  return identity
}

/** The sentence the round-trip test speaks when the request names none. */
const SAMPLE = 'The audio bundle is reading this sentence and hearing it back.'

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'status',
  order: 40,
  title: 'Bundle inventory and round-trip test',
  description: 'Reports the mounted components and speaks a sentence back through dictation',
  routes: ['/audio/status', '/audio/echo'],
}

/** Required Host services: routes, the bundle's protocol service, and package identity. */
export const inject = ['webServer', 'audioProtocol']

/** One JSON response, always closing the response. */
function json (res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a JSON request body under a hard byte limit. */
async function readJson (req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/**
 * Mount the inventory routes.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Optional sample sentence for the round-trip test.
 */
export function apply (ctx, config = {}) {
  const protocol = ctx.audioProtocol
  const sample = typeof config.sample === 'string' && config.sample.trim() !== '' ? config.sample.trim().slice(0, 400) : SAMPLE

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('status', level, event, detail)
  }

  /** Route dispatcher under /audio, beside the shared log route core owns. */
  async function handler (req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/audio/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'method', message: 'GET /audio/status' } })
      }
      const components = protocol.components()
      const manifest = await whoami()
      return json(res, 200, {
        name: typeof manifest.name === 'string' ? manifest.name : 'dsh-plugin-audio',
        version: typeof manifest.version === 'string' ? manifest.version : null,
        components,
        providers: protocol.summary(),
        log: protocol.counts(),
      })
    }
    if (url.pathname === '/audio/echo') {
      if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'POST /audio/echo' } })
      let body
      try {
        body = await readJson(req, 4096)
      } catch (error) {
        return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
      }
      const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim().slice(0, 500) : sample
      await Promise.all([protocol.discover('tts'), protocol.discover('stt')])
      const spoken = protocol.resolve('tts', {}, {})
      if (spoken === null) {
        note('warn', 'no-speech-model', { direction: 'tts' })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
      }
      const heard = protocol.resolve('stt', {}, {})
      if (heard === null) {
        note('warn', 'no-speech-model', { direction: 'stt' })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
      }
      const startedSpeak = Date.now()
      let audio
      try {
        audio = await protocol.speak(spoken.server.baseURL, text, spoken.model.id, spoken.voice?.id ?? null, 1)
      } catch (error) {
        note('error', 'echo-speak-failed', { provider: spoken.server.id, status: error.status ?? 502, message: String(error.message ?? error).slice(0, 240) })
        return json(res, error.status ?? 502, { error: { code: 'speech', message: error.message } })
      }
      const speakMs = Date.now() - startedSpeak
      const startedTranscribe = Date.now()
      try {
        const transcript = await protocol.transcribe(heard.server.baseURL, heard.model, audio.body, null)
        const transcribeMs = Date.now() - startedTranscribe
        note('info', 'echo', {
          server: spoken.server.id,
          model: spoken.model.id,
          voice: spoken.voice?.id ?? null,
          bytes: audio.body.length,
          chars: text.length,
          transcript: transcript.slice(0, 240),
          speakMs,
          transcribeMs,
        })
        return json(res, 200, {
          input: text,
          transcript,
          server: spoken.server.id,
          model: spoken.model.id,
          voice: spoken.voice?.id ?? null,
          bytes: audio.body.length,
          speakMs,
          transcribeMs,
          heardBy: { server: heard.server.id, model: heard.model },
        })
      } catch (error) {
        note('error', 'echo-transcribe-failed', {
          provider: heard.server.id,
          status: error.status ?? 502,
          message: String(error.message ?? error).slice(0, 240),
        })
        return json(res, error.status ?? 502, { error: { code: 'transcribe', message: error.message } })
      }
    }
    return json(res, 404, { error: { code: 'route', message: `unknown audio route: ${url.pathname}` } })
  }

  note('info', 'ready', { sample: sample.length })

  for (const path of COMPONENT.routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), `dsh-plugin-audio: ${path} route`)
  }
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-audio: status component record')
}
