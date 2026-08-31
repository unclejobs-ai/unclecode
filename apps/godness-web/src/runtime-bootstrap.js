export const DEFAULT_CONTROL_ROOM_URL = 'http://127.0.0.1:17677'

/**
 * Read host-provided configuration once at runtime. The bearer token is never
 * read from Vite's build-time environment, a URL, or browser storage.
 */
export function readRuntimeBootstrap(runtimeConfig, buildServerUrl) {
  const config = runtimeConfig && typeof runtimeConfig === 'object' ? runtimeConfig : {}
  return {
    baseUrl: typeof config.baseUrl === 'string' && config.baseUrl.trim()
      ? config.baseUrl
      : typeof buildServerUrl === 'string' && buildServerUrl.trim()
        ? buildServerUrl
        : DEFAULT_CONTROL_ROOM_URL,
    token: typeof config.token === 'string' ? config.token.trim() : '',
  }
}
