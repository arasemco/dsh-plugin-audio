/**
 * The bundle contract itself: one package, several component rows. These checks
 * are the ones the Host applies when it composes the layer and picks up the
 * browser half, kept here so a rename cannot silently break the composition —
 * a subpath row, for example, is skipped by the client-half scan, so exactly one
 * row has to name the bare package.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')

/**
 * The `id` / `name` pairs the bundle patch inserts, in declaration order.
 * The patch is a plain list of rows under one `insert:`; parsing it here keeps
 * the check dependency-free instead of pulling a YAML reader into the package.
 * @returns the inserted rows.
 */
function rowsOf () {
  const rows = []
  let current = null
  for (const line of patch.split('\n')) {
    const row = /^\s+- id: (\S+)$/.exec(line)
    if (row !== null) {
      current = { id: row[1] }
      rows.push(current)
      continue
    }
    const name = /^\s+name: (\S+)$/.exec(line)
    if (name !== null && current !== null) current.name = name[1]
  }
  return rows
}

const rows = rowsOf()

test('the package declares itself a bundle with a browser half', () => {
  assert.equal(manifest.name, 'dsh-plugin-audio')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

test('the patch inserts one row per component, with unique ids', () => {
  assert.deepEqual(rows.map((row) => row.id), ['audio-core', 'audio-tts', 'audio-stt', 'audio-status'])
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'the webserver and Loader key by these ids')
})

test('every row names a module this package exports', () => {
  for (const row of rows) {
    const subpath = row.name === manifest.name ? '.' : `.${row.name.slice(manifest.name.length)}`
    assert.ok(Object.hasOwn(manifest.exports, subpath), `${row.name} must be an exported subpath`)
    assert.ok(manifest.files.some((entry) => entry.startsWith(subpath === '.' ? '' : subpath.slice(2))), `${row.name} must ship its module`)
  }
})

test('exactly one row names the bare package, which is what finds the browser half', () => {
  /* client-modules resolves a row's package manifest only for a specifier that
     is the package name itself: `dsh-plugin-audio/x` locates no manifest, so a
     bundle whose rows are all subpaths would ship a client half nobody mounts. */
  const bare = rows.filter((row) => row.name === manifest.name)
  assert.equal(bare.length, 1, 'one row must carry the package name')
  assert.equal(bare[0].id, 'audio-core', 'and it is the component that owns the package root export')
  assert.equal(manifest.exports['.'], './core/index.js')
})

test('every component exposes apply and inject, and a display title', async () => {
  const expected = {
    'audio-core': ['./core', './core/locale/en.json'],
    'audio-tts': ['./tts', './tts/locale/en.json'],
    'audio-stt': ['./stt', './stt/locale/en.json'],
    'audio-status': ['./status', './status/locale/en.json'],
  }
  for (const [id, [modulePath, localePath]] of Object.entries(expected)) {
    const subpath = id === 'audio-core' ? './core' : `./${id.slice('audio-'.length)}`
    assert.equal(manifest.exports[subpath], `${modulePath}/index.js`)
    const module = await import(new URL(`${modulePath}/index.js`, root))
    assert.equal(typeof module.apply, 'function', `${id} applies`)
    assert.ok(Array.isArray(module.inject), `${id} declares its services`)
    /* The row title and description on the Plugins page come from this file. */
    const locale = JSON.parse(readFileSync(new URL(localePath, root), 'utf8'))
    assert.equal(typeof locale.meta.title, 'string')
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(manifest.exports[`${subpath}/locale/*.json`] !== undefined, `${subpath} must expose its locale`)
  }
})

test('the bundle card carries its own title and description', () => {
  const locale = JSON.parse(readFileSync(new URL('locale/en.json', root), 'utf8'))
  assert.equal(locale.meta.title, 'Audio')
  assert.ok(locale.meta.description.includes('four switchable components'))
  assert.deepEqual(manifest.exports['./locale/*.json'], './locale/*.json')
})

test('the package ships what the patch and the browser need, and nothing else', () => {
  for (const required of ['core/index.js', 'tts/index.js', 'stt/index.js', 'status/index.js', 'lib/client.js', 'lib/config.js', 'lib/http.js', 'lib/protocol.js', 'README.md', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(required), `${required} must ship`)
  }
})

test('every row reuses the shared modules instead of restating them', () => {
  /* One implementation per concern: the JSON/route plumbing, the config
     readers, and the protocol engine are imported, never copied per row. */
  const expected = {
    'core/index.js': ['../lib/http.js', '../lib/protocol.js', '../lib/config.js'],
    'tts/index.js': ['../lib/http.js', '../lib/config.js'],
    'stt/index.js': ['../lib/http.js', '../lib/config.js'],
    'status/index.js': ['../lib/http.js'],
  }
  for (const [module, imports] of Object.entries(expected)) {
    const source = readFileSync(new URL(module, root), 'utf8')
    for (const specifier of imports) {
      assert.match(source, new RegExp(`from '${specifier.replace(/[/.]/g, '\\$&')}'`), `${module} imports ${specifier}`)
    }
    assert.doesNotMatch(source, /function (json|readJson|number|follow|baseUrl)\b/, `${module} must not restate a shared helper`)
  }
})

test('the status row reads its identity from the package root it ships beside', () => {
  /* `files` ships no package.json copy inside a subdirectory, so the version the
     inventory reports comes from the manifest one directory up. */
  const status = readFileSync(new URL('status/index.js', root), 'utf8')
  assert.match(status, /new URL\('\.\.\/package\.json', import\.meta\.url\)/)
})
