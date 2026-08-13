export const SERVER_CLOCK_FRESHNESS_MS = 30_000
export const MAX_SERVER_CLOCK_OFFSET_MS = 5 * 60_000

export class ServerClockError extends Error {
  constructor() {
    super('Remote approval server clock is invalid')
  }
}

type ServerClockSample = {
  serverNowMs: number
  observedAtMonotonicMs: number
}

/** Projects a recent server sample using monotonic elapsed time. */
export class ServerClock {
  private sample: ServerClockSample | null = null
  private lastServerNowMs = -Infinity

  constructor(
    private readonly wallNow: () => number = () => Date.now(),
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  accept(serverNowMs: number): number {
    const wallNow = this.wallNow()
    const observedAtMonotonicMs = this.monotonicNow()
    const offset = serverNowMs - wallNow
    if (!Number.isFinite(serverNowMs)
      || !Number.isFinite(wallNow)
      || !Number.isFinite(observedAtMonotonicMs)
      || !Number.isFinite(offset)
      || Math.abs(offset) > MAX_SERVER_CLOCK_OFFSET_MS
      || serverNowMs < this.lastServerNowMs) {
      this.invalidate()
      throw new ServerClockError()
    }
    this.sample = { serverNowMs, observedAtMonotonicMs }
    this.lastServerNowMs = serverNowMs
    return serverNowMs
  }

  invalidate(): void {
    this.sample = null
  }

  authoritativeNow(): number | null {
    if (!this.sample) return null
    const sampleAge = this.monotonicNow() - this.sample.observedAtMonotonicMs
    if (!Number.isFinite(sampleAge) || sampleAge < 0 || sampleAge >= SERVER_CLOCK_FRESHNESS_MS) {
      this.invalidate()
      return null
    }
    const serverNow = this.sample.serverNowMs + sampleAge
    if (!Number.isFinite(serverNow) || serverNow < this.sample.serverNowMs) {
      this.invalidate()
      return null
    }
    return serverNow
  }
}
