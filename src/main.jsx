import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './Root.jsx'
import { DataProvider } from './contexts/DataContext.jsx'
import { registerServiceWorker } from './registerSW.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DataProvider>
      <Root />
    </DataProvider>
  </StrictMode>,
)

registerServiceWorker()
