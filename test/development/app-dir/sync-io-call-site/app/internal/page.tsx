import { readFileSync } from 'fs'
import { join } from 'path'

export default function Page() {
  // graceful-fs (bundled inside the compiled watchpack) patches fs.closeSync
  // globally and reads Date.now() in its bookkeeping on every close. The read
  // happens synchronously inside this render, but it's framework-internal and
  // never reaches the render's output.
  const contents = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  return <p>{`file-size-${contents.length}`}</p>
}
