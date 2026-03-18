import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'green-screen-react/styles.css'
import './App.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
