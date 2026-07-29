import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Placeholder mount. Task 9 replaces this body with the router shell; this
// task only has to prove that the tree builds and that the tokens load.
const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <main className="flex h-full items-center justify-center">
      <p className="font-mono text-sm text-(--flue-muted)">flue</p>
    </main>
  </StrictMode>,
)
