'use client'

import { Suspense, use } from 'react'

function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <main id="spa-item">item-{id}</main>
}

export default function SpaItem({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  return (
    <Suspense fallback={<p id="item-loading">loading-item</p>}>
      <Item params={params} />
    </Suspense>
  )
}
