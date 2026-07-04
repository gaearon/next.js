'use client'

import { use } from 'react'

export default function SpaItem({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  return <main id="spa-item">item-{id}</main>
}
