import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { createControlRoomStore } from './control-room-store.js'
import { readRuntimeBootstrap } from './runtime-bootstrap.js'

const runtimeConfig = Reflect.get(window, '__UNCLECODE_CONFIG__')
const bootstrap = readRuntimeBootstrap(
  runtimeConfig,
  import.meta.env.VITE_UNCLECODE_SERVER_URL,
)
const store = createControlRoomStore(bootstrap)

void store.start()
window.addEventListener('pagehide', () => store.stop(), { once: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
)
