import { ReactNode } from 'react'
import Link from 'next/link'

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <nav>
          <Link href="/" id="to-home">
            home
          </Link>
          <Link href="/spa" id="to-spa">
            spa
          </Link>
          <Link href="/spa/9" id="to-spa-9">
            spa/9
          </Link>
          <Link href="/server-page" id="to-server">
            server
          </Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
