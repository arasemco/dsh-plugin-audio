/**
 * dsh-plugin-audio — configuration reading shared by the bundle's rows.
 *
 * Every row's `apply` receives raw profile config: values may be strings from
 * YAML, a single value where a list is expected, or `undefined`. These helpers
 * normalize that once, so no row invents its own clamping rules.
 */

/**
 * Clamp one numeric config value.
 * @param value - raw config value (number or numeric string).
 * @param fallback - value used when the input is not finite.
 * @param min - lowest accepted value.
 * @param max - highest accepted value.
 * @returns The clamped number.
 */
export function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Strip trailing slashes so endpoint building is predictable.
 * @param value - base URL as configured.
 * @returns The URL without a trailing slash.
 */
export function baseUrl (value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Walk one path through a settings value.
 * @param value - section root.
 * @param path - path segments from the provider directory.
 * @returns The value at that path, or undefined.
 */
export function follow (value, path) {
  let current = value
  for (const key of path ?? []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * Read a config value as a non-empty numeric list, falling back when unset.
 * @param value - raw config value.
 * @param fallback - list used when the input is empty.
 * @returns The list.
 */
export function numbers (value, fallback) {
  const list = (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'number' ? entry : Number.parseFloat(entry)))
    .filter((entry) => Number.isFinite(entry))
  return list.length > 0 ? list : fallback
}
