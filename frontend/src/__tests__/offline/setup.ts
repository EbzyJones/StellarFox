/**
 * Setup file for the offline test suite.
 * Polyfills structuredClone for environments that don't have it (Node < 17).
 */

if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));
}
