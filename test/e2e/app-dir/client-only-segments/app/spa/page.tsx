'use client'

import { useState } from 'react'

export default function SpaPage() {
  const [count, setCount] = useState(0)
  return (
    <main id="spa">
      <p id="spa-content">spa-client-content</p>
      <button id="counter" onClick={() => setCount(count + 1)}>
        count: {count}
      </button>
    </main>
  )
}
