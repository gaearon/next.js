import { workAsyncStorage } from '../app-render/work-async-storage.external'
import { workUnitAsyncStorage } from '../app-render/work-unit-async-storage.external'
import { abortOnSynchronousPlatformIOAccess } from '../app-render/dynamic-rendering'
import { RenderStage } from '../app-render/staged-rendering'
import { applyOwnerStack } from '../dynamic-rendering-utils'
import {
  createSyncIOClientError,
  createSyncIOError,
  createSyncIORuntimeError,
  type SyncIOApiType,
} from '../app-render/sync-io-messages'
import { findSourceMap } from 'module'

type SyncIOCallSite =
  | { kind: 'application' }
  | { kind: 'internal' }
  | { kind: 'dependency'; packageName: string }

// Matches the last node_modules segment so pnpm's nested layout
// (.pnpm/pkg@1.0.0/node_modules/pkg/...) resolves to the real package name.
const packageNameRegex = /.*node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/

const frameLocationRegex = /(?:\(|at )([^()]+):(\d+):(\d+)\)?$/

function classifyPath(path: string): SyncIOCallSite | null {
  if (path.includes('/next/dist/')) {
    return { kind: 'internal' }
  }
  const match = packageNameRegex.exec(path)
  if (match !== null) {
    return { kind: 'dependency', packageName: match[1].replace(/\\/g, '/') }
  }
  return null
}

/**
 * Classifies the code that performed a sync IO read, from the call stack at
 * the moment of the access.
 *
 * Next.js reserves `Date` for output and `performance` for introspection, but
 * that convention doesn't extend to code we bundle: graceful-fs (inside the
 * compiled watchpack) reads `Date.now()` in its retry bookkeeping on every
 * `fs.close`, synchronously inside whatever context called `fs` — including a
 * tracked render. Reads like that never influence the render's output, so
 * they must not be tracked. Reads from the application's dependencies do
 * influence output and are tracked, with the package named in the error.
 */
function classifySyncIOCallSite(): SyncIOCallSite {
  const stack = new Error().stack
  if (!stack) {
    return { kind: 'application' }
  }
  for (const line of stack.split('\n').slice(1)) {
    const location = frameLocationRegex.exec(line)
    if (location === null) {
      continue
    }
    const path = location[1].replace(/\\/g, '/')

    if (path.includes('/next/dist/server/node-environment-extensions/')) {
      // The IO patch itself (and this helper).
      continue
    }
    if (path.startsWith('node:')) {
      // Node core is transparent: it sits between the patch and the caller
      // for delegated APIs (node:crypto's getRandomValues, fs internals).
      continue
    }

    const classified = classifyPath(path)
    if (classified !== null) {
      return classified
    }

    // The frame points at bundled output (a dev server chunk, for example).
    // Resolve the original source through the bundle's source map.
    const sourceMap =
      findSourceMap(path) ?? findSourceMap(`file://${path}`) ?? undefined
    const entry = sourceMap?.findEntry(
      Number(location[2]) - 1,
      Number(location[3]) - 1
    )
    if (entry !== undefined && entry.originalSource) {
      const originalClassified = classifyPath(
        entry.originalSource.replace(/\\/g, '/')
      )
      if (originalClassified !== null) {
        return originalClassified
      }
    }
    return { kind: 'application' }
  }
  return { kind: 'application' }
}

export function io(expression: string, type: SyncIOApiType) {
  const workUnitStore = workUnitAsyncStorage.getStore()
  const workStore = workAsyncStorage.getStore()

  if (!workUnitStore || !workStore) {
    return
  }

  switch (workUnitStore.type) {
    case 'prerender':
    case 'prerender-runtime': {
      const prerenderSignal = workUnitStore.controller.signal

      if (prerenderSignal.aborted === false) {
        const callSite = classifySyncIOCallSite()
        if (callSite.kind === 'internal') {
          break
        }
        // If the prerender signal is already aborted we don't need to construct
        // any stacks because something else actually terminated the prerender.
        abortOnSynchronousPlatformIOAccess(
          workStore.route,
          expression,
          applyOwnerStack(
            createSyncIOError(
              workStore.route,
              expression,
              type,
              callSite.kind === 'dependency' ? callSite.packageName : undefined
            )
          ),
          workUnitStore
        )
      }
      break
    }
    case 'prerender-client': {
      const prerenderSignal = workUnitStore.controller.signal

      if (prerenderSignal.aborted === false) {
        const callSite = classifySyncIOCallSite()
        if (callSite.kind === 'internal') {
          break
        }
        // If the prerender signal is already aborted we don't need to construct
        // any stacks because something else actually terminated the prerender.
        abortOnSynchronousPlatformIOAccess(
          workStore.route,
          expression,
          applyOwnerStack(
            createSyncIOClientError(
              workStore.route,
              expression,
              type,
              callSite.kind === 'dependency' ? callSite.packageName : undefined
            )
          ),
          workUnitStore
        )
      }
      break
    }
    case 'request': {
      const stageController = workUnitStore.stagedRendering
      if (stageController && stageController.shouldTrackSyncInterrupt()) {
        const callSite = classifySyncIOCallSite()
        if (callSite.kind === 'internal') {
          break
        }
        const calledFrom =
          callSite.kind === 'dependency' ? callSite.packageName : undefined
        let syncIOError: Error
        if (
          stageController.currentStage === RenderStage.Static ||
          stageController.currentStage === RenderStage.EarlyStatic
        ) {
          syncIOError = createSyncIOError(
            workStore.route,
            expression,
            type,
            calledFrom
          )
        } else {
          // We're in the Runtime stage.
          // We only error for Sync IO in the Runtime stage if the route has a runtime prefetch config.
          // This check is implemented in `stageController.canSyncInterrupt()` --
          // if runtime prefetching isn't enabled, then we won't get here.
          syncIOError = createSyncIORuntimeError(
            workStore.route,
            expression,
            type,
            calledFrom
          )
        }

        syncIOError = applyOwnerStack(syncIOError)
        stageController.syncInterruptCurrentStageWithReason(syncIOError)

        // A validation render uses a 'request' store type, but may be abortable.
        // If we're rendering with filled caches, Sync IO is an error and should trigger an abort.
        if (
          workUnitStore.controller &&
          !workUnitStore.controller.signal.aborted
        ) {
          workUnitStore.controller.abort(syncIOError)
        }
      }
      break
    }
    case 'validation-client':
    case 'prerender-ppr':
    case 'prerender-legacy':
    case 'cache':
    case 'private-cache':
    case 'unstable-cache':
    case 'generate-static-params':
      break
    default:
      workUnitStore satisfies never
  }
}
