/**
 * Reload-stable handles shared across extension factory re-invocations.
 * Inspired by pi-task's globalThis config / remote bridge pattern:
 * jiti/reload must not orphan running local locks or leave dual monitors.
 */

import type { LocalStreamLock } from "../local-lock.ts";
import { createLocalStreamLock } from "../local-lock.ts";

type GlobalHerd = {
  localLock?: LocalStreamLock;
  disposePrevious?: () => void;
};

const GLOBAL_KEY = "__piHerdrHarness";

function bag(): GlobalHerd {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: GlobalHerd;
  };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
  return g[GLOBAL_KEY];
}

/** Single local stream lock across /reload so GPU seat accounting stays honest. */
export function getOrCreateLocalLock(maxStreams: number): LocalStreamLock {
  const g = bag();
  if (!g.localLock) {
    g.localLock = createLocalStreamLock(maxStreams);
  } else {
    g.localLock.setMaxStreams(maxStreams);
  }
  return g.localLock;
}

/** Run previous extension instance cleanup, then register the new dispose. */
export function replaceHarnessDispose(dispose: () => void): void {
  const g = bag();
  try {
    g.disposePrevious?.();
  } catch {
    /* previous instance already gone */
  }
  g.disposePrevious = dispose;
}
