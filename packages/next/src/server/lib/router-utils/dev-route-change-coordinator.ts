export type DevRouteChanges = {
  added: string[]
  removed: string[]
}

export function createDevRouteChangeCoordinator(
  onChanges: (changes: DevRouteChanges) => void
) {
  let watchpackRoutes: Set<string> | undefined
  let bundlerRoutes: Set<string> | undefined
  let announcedRoutes: Set<string> | undefined

  const reconcile = () => {
    if (!watchpackRoutes || !bundlerRoutes) return

    if (!announcedRoutes) {
      announcedRoutes = new Set(
        [...watchpackRoutes].filter((route) => bundlerRoutes!.has(route))
      )
      return
    }

    const nextAnnouncedRoutes = new Set(announcedRoutes)
    const added: string[] = []
    const removed: string[] = []
    const routes = new Set([
      ...announcedRoutes,
      ...watchpackRoutes,
      ...bundlerRoutes,
    ])

    for (const route of routes) {
      const watchpackHasRoute = watchpackRoutes.has(route)
      const bundlerHasRoute = bundlerRoutes.has(route)

      // Preserve the last announced state until both producers agree.
      if (watchpackHasRoute !== bundlerHasRoute) continue

      if (watchpackHasRoute) {
        if (!nextAnnouncedRoutes.has(route)) {
          nextAnnouncedRoutes.add(route)
          added.push(route)
        }
      } else if (nextAnnouncedRoutes.delete(route)) {
        removed.push(route)
      }
    }

    announcedRoutes = nextAnnouncedRoutes
    if (added.length > 0 || removed.length > 0) {
      onChanges({ added, removed })
    }
  }

  return {
    updateWatchpack(routes: Iterable<string>) {
      watchpackRoutes = new Set(routes)
      reconcile()
    },
    updateBundler(routes: Iterable<string>) {
      bundlerRoutes = new Set(routes)
      reconcile()
    },
  }
}

export type DevRouteChangeCoordinator = ReturnType<
  typeof createDevRouteChangeCoordinator
>
