import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { createControlRoomStore } from './control-room-store.js'

const runtimeConfig = window.__UNCLECODE_CONFIG__ ?? {}
const store = createControlRoomStore({
  baseUrl: runtimeConfig.baseUrl ?? import.meta.env.VITE_UNCLECODE_SERVER_URL ?? 'http://127.0.0.1:17677',
  token: runtimeConfig.token ?? import.meta.env.VITE_UNCLECODE_SERVER_TOKEN ?? '',
})

void store.start()
window.addEventListener('pagehide', () => store.stop(), { once: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
)
