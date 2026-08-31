# UncleCode Web

The web control room is a read-model and control client for the persistent UncleCode runtime. It does not run a second harness or SCC process, open a browser, or embed external social content.

Configure the non-secret `VITE_UNCLECODE_SERVER_URL`, then run `npm run dev`. Supply the bearer token at runtime through `window.__UNCLECODE_CONFIG__ = { baseUrl, token }` before `src/main.jsx` loads, or enter it into the in-memory connection form. The token is not accepted from a Vite build-time variable, URL, local storage, or session storage.

The client only sends credentials to an HTTP(S) loopback origin. All mutations pass through the server's typed runtime controls and canonical policy boundary.
