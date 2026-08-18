import type { RouteDefinition } from '../../../packages/next/src/server/route-definitions/route-definition'
import {
  createFilesystemRouteSnapshotStore,
  type FilesystemDynamicRoute,
  type FilesystemRouteSnapshotInput,
} from '../../../packages/next/src/server/lib/router-utils/filesystem'
import { createSerializedAsyncCallback } from '../../../packages/next/src/server/lib/router-utils/serialized-async-callback'
import {
  createDevRouteChangeCoordinator,
  type DevRouteChanges,
} from '../../../packages/next/src/server/lib/router-utils/dev-route-change-coordinator'

function definition(pathname: string): RouteDefinition {
  return {
    kind: 'PAGES' as RouteDefinition['kind'],
    pathname,
    page: pathname,
    bundlePath: `pages${pathname}`,
    filename: `${pathname}.tsx`,
  }
}

function dynamicRoute(page: string): FilesystemDynamicRoute {
  return {
    page,
    regex: '',
    match: (pathname) => (pathname === page ? {} : false),
  }
}

function generation(pathname: string): FilesystemRouteSnapshotInput {
  return {
    appFiles: [pathname],
    pageFiles: [],
    staticMetadataFiles: [[`${pathname}/icon.png`, `${pathname}/icon.png`]],
    dynamicRoutes: [dynamicRoute(`${pathname}/[slug]`)],
    nextDataRoutes: [pathname],
    routeDefinitions: {
      appFile: [definition(pathname)],
      pageFile: [],
    },
  }
}

describe('dev route snapshots', () => {
  it('publishes every route fact as one generation', () => {
    const store = createFilesystemRouteSnapshotStore(generation('/old'))
    const oldGeneration = store.current

    store.publish(generation('/new'))

    expect(store.current.hasAppFile('/new')).toBe(true)
    expect(store.current.getStaticMetadataFile('/new/icon.png')).toBe(
      '/new/icon.png'
    )
    expect(store.current.dynamicRoutes[0].page).toBe('/new/[slug]')
    expect(store.current.hasNextDataRoute('/new')).toBe(true)
    expect(store.current.getRouteDefinitions('appFile', '/new')).toHaveLength(1)

    expect(oldGeneration.hasAppFile('/old')).toBe(true)
    expect(oldGeneration.dynamicRoutes[0].page).toBe('/old/[slug]')
    expect(oldGeneration.getRouteDefinitions('appFile', '/old')).toHaveLength(1)
  })

  it('leaves the committed generation unchanged when candidate construction fails', () => {
    const store = createFilesystemRouteSnapshotStore(generation('/old'))
    const committed = store.current
    const candidate = generation('/new')
    candidate.appFiles = {
      *[Symbol.iterator]() {
        yield '/new'
        throw new Error('candidate failed')
      },
    }

    expect(() => store.publish(candidate)).toThrow('candidate failed')
    expect(store.current).toBe(committed)
  })

  it('copies candidate collections before publication', () => {
    const candidate = generation('/new')
    const appFiles = new Set(candidate.appFiles)
    candidate.appFiles = appFiles
    const store = createFilesystemRouteSnapshotStore(generation('/old'))

    store.publish(candidate)
    appFiles.clear()

    expect(store.current.hasAppFile('/new')).toBe(true)
    expect('appFiles' in store.current).toBe(false)
    expect('staticMetadataFiles' in store.current).toBe(false)
  })
})

describe('serialized dev route scans', () => {
  it('finishes scans in event order', async () => {
    let finishFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const events: string[] = []
    const scan = createSerializedAsyncCallback(async (value: string) => {
      events.push(`start ${value}`)
      if (value === 'first') await firstCanFinish
      events.push(`finish ${value}`)
    })

    const first = scan('first')
    const second = scan('second')
    await Promise.resolve()
    expect(events).toEqual(['start first'])

    finishFirst()
    await Promise.all([first, second])
    expect(events).toEqual([
      'start first',
      'finish first',
      'start second',
      'finish second',
    ])
  })

  it('continues after a failed scan', async () => {
    const events: string[] = []
    const scan = createSerializedAsyncCallback(async (value: string) => {
      events.push(value)
      if (value === 'first') throw new Error('scan failed')
    })

    const first = scan('first')
    const second = scan('second')

    await expect(first).rejects.toThrow('scan failed')
    await expect(second).resolves.toBeUndefined()
    expect(events).toEqual(['first', 'second'])
  })
})

describe('dev route change coordination', () => {
  it.each(['watchpack', 'bundler'] as const)(
    'announces an addition after %s catches up',
    (producerThatCatchesUp) => {
      const changes: DevRouteChanges[] = []
      const coordinator = createDevRouteChangeCoordinator((change) =>
        changes.push(change)
      )

      coordinator.updateWatchpack(['/existing'])
      coordinator.updateBundler(['/existing'])
      if (producerThatCatchesUp === 'watchpack') {
        coordinator.updateBundler(['/existing', '/added'])
        expect(changes).toEqual([])
        coordinator.updateWatchpack(['/existing', '/added'])
      } else {
        coordinator.updateWatchpack(['/existing', '/added'])
        expect(changes).toEqual([])
        coordinator.updateBundler(['/existing', '/added'])
      }

      expect(changes).toEqual([{ added: ['/added'], removed: [] }])
    }
  )

  it('does not announce an addition if the leading producer rolls back', () => {
    const changes: DevRouteChanges[] = []
    const coordinator = createDevRouteChangeCoordinator((change) =>
      changes.push(change)
    )

    coordinator.updateWatchpack(['/existing'])
    coordinator.updateBundler(['/existing'])
    coordinator.updateBundler(['/existing', '/transient'])
    coordinator.updateBundler(['/existing'])
    coordinator.updateWatchpack(['/existing'])

    expect(changes).toEqual([])
  })

  it.each(['watchpack', 'bundler'] as const)(
    'announces a removal after %s catches up',
    (producerThatCatchesUp) => {
      const changes: DevRouteChanges[] = []
      const coordinator = createDevRouteChangeCoordinator((change) =>
        changes.push(change)
      )

      coordinator.updateWatchpack(['/existing'])
      coordinator.updateBundler(['/existing'])
      if (producerThatCatchesUp === 'watchpack') {
        coordinator.updateBundler([])
        expect(changes).toEqual([])
        coordinator.updateWatchpack([])
      } else {
        coordinator.updateWatchpack([])
        expect(changes).toEqual([])
        coordinator.updateBundler([])
      }

      expect(changes).toEqual([{ added: [], removed: ['/existing'] }])
    }
  )

  it('preserves the announced route if the leading producer rolls back a removal', () => {
    const changes: DevRouteChanges[] = []
    const coordinator = createDevRouteChangeCoordinator((change) =>
      changes.push(change)
    )

    coordinator.updateWatchpack(['/existing'])
    coordinator.updateBundler(['/existing'])
    coordinator.updateWatchpack([])
    coordinator.updateWatchpack(['/existing'])
    coordinator.updateBundler(['/existing'])

    expect(changes).toEqual([])
  })

  it('emits no initial changes regardless of producer order', () => {
    for (const watchpackFirst of [true, false]) {
      const changes: DevRouteChanges[] = []
      const coordinator = createDevRouteChangeCoordinator((change) =>
        changes.push(change)
      )

      if (watchpackFirst) {
        coordinator.updateWatchpack(['/existing'])
        coordinator.updateBundler(['/existing'])
      } else {
        coordinator.updateBundler(['/existing'])
        coordinator.updateWatchpack(['/existing'])
      }

      expect(changes).toEqual([])
    }
  })
})
