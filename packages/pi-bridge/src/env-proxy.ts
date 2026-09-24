import * as http from "node:http";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
// The TUI reaches the runtime owner over loopback; a proxy cannot route back to it.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

type SetGlobalProxyFromEnv = (env: NodeJS.ProcessEnv) => void;

// Present in Node 24.20; not declared by the installed @types/node, and absent on older Nodes.
function builtinProxySetter(): SetGlobalProxyFromEnv | undefined {
  const candidate: unknown = Reflect.get(http, "setGlobalProxyFromEnv");
  return typeof candidate === "function" ? (env) => Reflect.apply(candidate, http, [env]) : undefined;
}

let enabled = false;

/**
 * pi-ai (model calls and OAuth flows) uses the global `fetch`, which ignores proxy
 * environment variables by default. Route it through HTTP(S)_PROXY like the native
 * transport does, keeping loopback direct. No-op without a proxy variable, or on a
 * Node without the built-in (unchanged direct behavior); once per process.
 */
export function enableEnvProxyForFetch(env: NodeJS.ProcessEnv = process.env): void {
  if (enabled) return;
  if (!PROXY_ENV_KEYS.some((key) => env[key]?.trim())) return;
  const setGlobalProxyFromEnv = builtinProxySetter();
  if (!setGlobalProxyFromEnv) return;
  const noProxy = [...(env.NO_PROXY ?? env.no_proxy ?? "").split(","), ...LOOPBACK_HOSTS]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(",");
  setGlobalProxyFromEnv({ ...env, NO_PROXY: noProxy, no_proxy: noProxy });
  enabled = true;
}
