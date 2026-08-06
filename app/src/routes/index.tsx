import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Index })

function Index() {
  return (
    <main>
      <h1>flue</h1>
      <p>The flue.sh control plane. Sign-in and daemon management arrive with the next build steps.</p>
    </main>
  )
}
