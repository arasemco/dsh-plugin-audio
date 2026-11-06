/**
 * dsh-plugin-audio — the dictation component (`audio-stt`).
 *
 * Same shape as the read-aloud row, in the other direction: nothing is
 * transcribed here. The recording is forwarded to a provider that implements the
 * OpenAI transcription API and the text it produced is returned.
 *
 *   GET  /stt/info       → providers that can transcribe, and every model they list
 *   POST /stt/transcribe → WAV in, { text } out, via <provider>/audio/transcriptions
 *
 * Discovery, the wire call, and the event log belong to the `audio-core` row and
 * arrive as the `audioProtocol` service; this row owns the dictation surface and
 * its limits.
 */

/** Dictation defaults; no server, model, or language is assumed. */
const DEFAULTS = {
  /** Preferred provider/model; unset means "first discovered". */
  server: null,
  model: null,
  /** Language hint; unset sends none and lets the model detect it. */
  language: null,
  /** Largest accepted recording. */
  maxAudioBytes: 32 * 1024 * 1024,
}

/** Language hints offered by the GUI; the provider decides what it supports. */
const LANGUAGES = ['auto', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'zh', 'ja', 'ko', 'yue']

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'stt',
  order: 30,
  title: 'Dictate instead of typing',
  description: 'Records the microphone on the Host and transcribes it with the discovered provider',
  routes: ['/stt/info', '/stt/transcribe'],
}

/** Required Host services: routes and the bundle's protocol service. */
export const inject = ['webServer', 'audioProtocol']

/** Clamp a numeric config value. */
function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

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

/** Read a request body under a hard byte limit. */
async function readBody (req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('recording is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Mount the dictation routes.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Preferences and the accepted recording size.
 */
export function apply (ctx, config = {}) {
  const options = {
    ...DEFAULTS,
    ...config,
    maxAudioBytes: number(config.maxAudioBytes, DEFAULTS.maxAudioBytes, 1024, 512 * 1024 * 1024),
  }
  const protocol = ctx.audioProtocol

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('stt', level, event, detail)
  }

  /**
   * Resolve one request against the discovered providers.
   * @param wanted - explicitly requested provider and model.
   * @returns The resolved pair, or null when nothing corresponds.
   */
  function choose (wanted = {}) {
    return protocol.resolve('stt', wanted, {
      server: options.server ?? undefined,
      model: options.model ?? undefined,
    })
  }

  /** Route dispatcher: every unmatched path under /stt answers JSON, never HTML. */
  async function handler (req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/stt/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'method', message: 'GET /stt/info' } })
      }
      const servers = await protocol.discover('stt', url.searchParams.get('refresh') === '1')
      const fallback = choose()
      return json(res, 200, {
        servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
        defaults: { server: fallback?.server.id ?? null, model: fallback?.model ?? null },
        languages: LANGUAGES,
        component: COMPONENT.id,
      })
    }
    if (url.pathname === '/stt/transcribe') {
      if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'POST /stt/transcribe' } })
      await protocol.discover('stt')
      const chosen = choose({
        server: url.searchParams.get('server') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
      })
      if (chosen === null) {
        note('warn', 'no-speech-model', { providers: 0 })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
      }
      const requested = url.searchParams.get('language') ?? options.language
      const language = requested === null || requested === undefined || requested === '' || requested === 'auto' ? null : requested
      let body
      try {
        body = await readBody(req, options.maxAudioBytes)
      } catch (error) {
        return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
      }
      if (body.length === 0) return json(res, 400, { error: { code: 'body', message: 'no audio received' } })
      if (body.length < 1600) return json(res, 400, { error: { code: 'audio', message: 'recording is too short' } })
      try {
        const started = Date.now()
        const text = await protocol.transcribe(chosen.server.baseURL, chosen.model, body, language)
        const ms = Date.now() - started
        note('info', 'transcribed', {
          provider: chosen.server.id,
          model: chosen.model,
          chars: text.trim().length,
          bytes: body.length,
          language: language ?? 'auto',
          ms,
        })
        return json(res, 200, { text: text.trim(), server: chosen.server.id, model: chosen.model, ms })
      } catch (error) {
        note('error', 'transcription-failed', {
          provider: chosen.server.id,
          model: chosen.model,
          bytes: body.length,
          language: language ?? 'auto',
          status: error.status ?? 502,
          message: String(error.message ?? error).slice(0, 240),
        })
        return json(res, error.status ?? 502, { error: { code: 'transcribe', message: error.message } })
      }
    }
    return json(res, 404, { error: { code: 'route', message: `unknown stt route: ${url.pathname}` } })
  }

  note('info', 'ready', {
    maxAudioBytes: options.maxAudioBytes,
    language: options.language,
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/stt', handler }), 'dsh-plugin-audio: /stt routes')
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-audio: stt component record')
}
