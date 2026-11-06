/**
 * dsh-plugin-audio — the read-aloud component (`audio-tts`).
 *
 * The browser never reaches a speech engine directly (no CORS, works from any
 * browser that can open the GUI, keeps engines on loopback):
 *
 *   GET  /tts/info   → discovered speech servers, their models and voices
 *   POST /tts/speak  → { text, server?, model?, voice?, speed? } → audio/wav bytes
 *   GET/POST /tts/cast → the multi-voice experiment flag the Host mirrors
 *
 * Discovery, the wire call, and the event log belong to the `audio-core` row and
 * arrive as the `audioProtocol` service; this row owns the read-aloud surface,
 * its preferences, and its audio cache.
 */

import { createHash } from 'node:crypto'

/** Read-aloud defaults; no server, model, or voice is assumed. */
const DEFAULTS = {
  /** Preferred server/model/voice; unset means "first discovered". */
  server: null,
  model: null,
  voice: null,
  /** Speaking rate applied when the request names none. */
  speed: 1,
  /** Rates offered by the GUI, applied by the browser's player. */
  speeds: [0.75, 1, 1.25, 1.5, 2],
  /** Upper bound for one synthesis request; the GUI splits longer replies. */
  maxChars: 4000,
  /** Total bytes of synthesized audio kept for instant re-listening. */
  cacheBytes: 24 * 1024 * 1024,
}

/**
 * The instruction injected while the multi-voice experiment is on. It rides the
 * system prompt, so the operator's own message is never modified.
 */
const CAST_INSTRUCTION = [
  '## Reading aloud with several voices',
  'A text-to-speech experiment is active: this reply may be read by more than one voice.',
  '- Write as a small cast only when the content genuinely has several voices — a dialogue, an interview, a review with distinct roles. Otherwise keep one narrator voice.',
  '- In a cast, put each speaker at the start of a line as `Name: sentence`, with two to four short, distinct names, and prefer several short labelled turns over one long block.',
  '- Never label ordinary prose, code, or lists: the narrator reads everything unlabelled.',
].join('\n')

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'tts',
  order: 20,
  title: 'Read replies aloud',
  description: 'Speaks the discovered speech engine into a seekable player',
  routes: ['/tts/info', '/tts/speak', '/tts/cast'],
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
 * Mount the read-aloud routes and the multi-voice experiment.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Preferences, rate list, request ceiling, and cache budget.
 */
export function apply (ctx, config = {}) {
  const options = {
    ...DEFAULTS,
    ...config,
    speeds: Array.isArray(config.speeds) && config.speeds.length > 0 ? config.speeds : DEFAULTS.speeds,
    maxChars: number(config.maxChars, DEFAULTS.maxChars, 1, 20000),
    cacheBytes: number(config.cacheBytes, DEFAULTS.cacheBytes, 0, 512 * 1024 * 1024),
  }
  const protocol = ctx.audioProtocol

  /** Synthesized-audio cache: key → bytes. Insertion order doubles as LRU order. */
  const cache = new Map()
  let cacheBytes = 0
  /** Whether the multi-voice experiment is on, as the browser last reported it. */
  let castEnabled = false

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('tts', level, event, detail)
  }

  /** Drop the oldest entries until the budget holds again. */
  function evict () {
    while (cacheBytes > options.cacheBytes && cache.size > 0) {
      const [key, entry] = cache.entries().next().value
      cache.delete(key)
      cacheBytes -= entry.body.length
    }
  }

  /**
   * Resolve one request against the discovered servers.
   * @param wanted - explicitly requested server, model, and voice.
   * @returns The resolved selection, or null when nothing corresponds.
   */
  function choose (wanted = {}) {
    return protocol.resolve('tts', wanted, {
      server: options.server ?? undefined,
      model: options.model ?? undefined,
      voice: options.voice ?? undefined,
    })
  }

  /**
   * Synthesize one request, serving the buffered audio when it is already known.
   * @param chosen - the resolved server/model/voice.
   * @param text - prose to synthesize.
   * @param speed - speaking rate.
   * @returns Audio, its type, and whether it came from the cache.
   */
  async function synthesize (chosen, text, speed) {
    const key = createHash('sha256')
      .update(`${chosen.server.baseURL}\u0000${chosen.model.id}\u0000${chosen.voice?.id ?? ''}\u0000${speed}\u0000${text}`)
      .digest('hex')
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return { ...hit, cached: true }
    }
    const audio = await protocol.speak(chosen.server.baseURL, text, chosen.model.id, chosen.voice?.id ?? null, speed)
    if (options.cacheBytes > 0 && audio.body.length <= options.cacheBytes) {
      cache.set(key, audio)
      cacheBytes += audio.body.length
      evict()
    }
    return { ...audio, cached: false }
  }

  /** Route dispatcher: every unmatched path under /tts answers JSON, never HTML. */
  async function handler (req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/tts/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'method', message: 'GET /tts/info' } })
      }
      const servers = await protocol.discover('tts', url.searchParams.get('refresh') === '1')
      const fallback = choose()
      return json(res, 200, {
        /* Ordering hints stay on the Host; the browser sees only what it renders. */
        servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
        defaults: {
          server: fallback?.server.id ?? null,
          model: fallback?.model.id ?? null,
          voice: fallback?.voice?.id ?? null,
          speed: number(options.speed, 1, 0.25, 4),
        },
        speeds: options.speeds,
        maxChars: options.maxChars,
        component: COMPONENT.id,
      })
    }
    if (url.pathname === '/tts/cast') {
      if (req.method === 'POST') {
        let body
        try {
          body = await readJson(req, 2048)
        } catch (error) {
          return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
        }
        const enabled = body?.enabled === true
        if (enabled !== castEnabled) {
          castEnabled = enabled
          note('info', enabled ? 'cast-enabled' : 'cast-disabled')
        }
        return json(res, 200, { enabled: castEnabled })
      }
      if (req.method === 'GET') return json(res, 200, { enabled: castEnabled })
      return json(res, 405, { error: { code: 'method', message: 'GET or POST /tts/cast' } })
    }
    if (url.pathname === '/tts/speak') {
      if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'POST /tts/speak' } })
      let body
      try {
        body = await readJson(req, 64 * 1024)
      } catch (error) {
        return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') return json(res, 400, { error: { code: 'text', message: 'text is required' } })
      if (text.length > options.maxChars) {
        return json(res, 413, { error: { code: 'text', message: `text exceeds ${options.maxChars} characters` } })
      }
      await protocol.discover('tts')
      const chosen = choose({
        server: typeof body.server === 'string' && body.server !== '' ? body.server : undefined,
        model: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
        voice: typeof body.voice === 'string' && body.voice !== '' ? body.voice : undefined,
      })
      if (chosen === null) {
        note('warn', 'no-speech-model', { requested: { server: body.server ?? null, model: body.model ?? null } })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
      }
      const speed = number(body.speed, number(options.speed, 1, 0.25, 4), 0.25, 4)
      try {
        const audio = await synthesize(chosen, text, speed)
        if (audio.cached) note('debug', 'synthesis-cache-hit', { model: chosen.model.id, chars: text.length })
        res.writeHead(200, {
          'content-type': audio.type,
          'content-length': audio.body.length,
          'cache-control': 'no-store',
          'x-tts-server': chosen.server.id,
          'x-tts-model': chosen.model.id,
          'x-tts-cache': audio.cached ? 'hit' : 'miss',
        })
        return res.end(audio.body)
      } catch (error) {
        note('error', 'synthesis-failed', {
          provider: chosen.server.id,
          model: chosen.model.id,
          voice: chosen.voice?.id ?? null,
          chars: text.length,
          status: error.status ?? 502,
          message: String(error.message ?? error).slice(0, 240),
        })
        return json(res, error.status ?? 502, { error: { code: 'speech', message: error.message } })
      }
    }
    return json(res, 404, { error: { code: 'route', message: `unknown tts route: ${url.pathname}` } })
  }

  /* Optional service: the routes above work even when no prompt registry exists. */
  ctx.inject?.(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dsh-audio-cast',
      order: 950,
      text: () => (castEnabled ? CAST_INSTRUCTION : ''),
    }), 'dsh-plugin-audio: multi-voice instruction')
    note('info', 'cast-instruction-registered', { chars: CAST_INSTRUCTION.length })
  })

  note('info', 'ready', {
    model: options.model,
    cacheBytes: options.cacheBytes,
    maxChars: options.maxChars,
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/tts', handler }), 'dsh-plugin-audio: /tts routes')
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-audio: tts component record')
}
