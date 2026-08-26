import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@remind-me/ui/tokens.css'
import { App } from './App'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root was not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
