import { randomBytes } from 'node:crypto'

function assertIdentity({ processId, processStartedAt }) {
  if (!Number.isInteger(processId) || processId <= 0 || !Number.isFinite(processStartedAt)) throw new Error('Exact process identity required')
}
function sameIdentity(left, right) { return left.processId === right.processId && left.processStartedAt === right.processStartedAt }

export class MemoryPreauthorization {
  constructor({ maxActive = 256, tokenBytes = 32 } = {}) {
    if (!Number.isInteger(maxActive) || maxActive <= 0 || !Number.isInteger(tokenBytes) || tokenBytes < 16) throw new Error('Preauthorization bounds invalid')
    this.maxActive = maxActive
    this.tokenBytes = tokenBytes
    this.grants = new Map()
  }

  #evict(now) {
    for (const [token, grant] of this.grants) if (grant.consumed || now >= grant.expiresAt) this.grants.delete(token)
  }

  issue({ contextId, householdId, requestId, pcId, gameId, allowanceVersion, expiresAt, now = Date.now() }) {
    this.#evict(now)
    if (![contextId, householdId, requestId, pcId, gameId].every((value) => typeof value === 'string' && value.length > 0) || !Number.isInteger(allowanceVersion) || allowanceVersion <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Invalid remote grant')
    if (this.grants.size >= this.maxActive) throw new Error('Preauthorization capacity reached')
    let token
    do { token = randomBytes(this.tokenBytes).toString('base64url') } while (this.grants.has(token))
    const grant = Object.freeze({ token, contextId, householdId, requestId, pcId, gameId, allowanceVersion, expiresAt, consumed: false, identity: null })
    this.grants.set(token, grant)
    return Object.freeze({ token, contextId, gameId, expiresAt })
  }

  consume({ token, contextId, gameId, processId, processStartedAt, now = Date.now() }) {
    this.#evict(now)
    const grant = this.grants.get(token)
    if (!grant || grant.consumed) throw new Error('Preauthorization unavailable')
    if (grant.contextId !== contextId || grant.gameId !== gameId) throw new Error('Preauthorization context mismatch')
    assertIdentity({ processId, processStartedAt })
    const consumed = Object.freeze({ ...grant, consumed: true, identity: Object.freeze({ processId, processStartedAt }) })
    this.grants.set(token, consumed)
    return Object.freeze({ householdId: consumed.householdId, requestId: consumed.requestId, pcId: consumed.pcId, gameId: consumed.gameId, allowanceVersion: consumed.allowanceVersion, processId, processStartedAt })
  }

  get(token, now = Date.now()) { this.#evict(now); const grant = this.grants.get(token); return grant && Object.freeze({ ...grant, identity: grant.identity && { ...grant.identity } }) }
}

export class RemoteStartCoordinator {
  constructor({ preauthorizations, finalPolicy, reconcile = async () => null }) {
    if (!preauthorizations || typeof preauthorizations.consume !== 'function' || typeof finalPolicy !== 'function' || typeof reconcile !== 'function') throw new Error('Start coordinator dependencies required')
    this.preauthorizations = preauthorizations
    this.finalPolicy = finalPolicy
    this.reconcile = reconcile
    this.queues = new Map()
    this.states = new Map()
  }

  #serial(contextId, work) {
    const next = (this.queues.get(contextId) ?? Promise.resolve()).catch(() => undefined).then(work)
    const queued = next.finally(() => { if (this.queues.get(contextId) === queued) this.queues.delete(contextId) })
    this.queues.set(contextId, queued)
    return next
  }

  observedUserLaunch({ token, contextId, gameId, processId, processStartedAt, now = Date.now() }) {
    return this.#serial(contextId, async () => {
      assertIdentity({ processId, processStartedAt })
      const identity = { processId, processStartedAt }
      const existing = this.states.get(contextId)
      if (existing) return existing.identity && sameIdentity(existing.identity, identity) ? { status: existing.status } : { status: 'ignored' }
      // This is a detector claim only: it never starts or signals a game process.
      if (!(await this.finalPolicy({ contextId, gameId, processId, processStartedAt, now }))) {
        this.states.set(contextId, { status: 'denied', identity, gameId })
        return { status: 'denied' }
      }
      try {
        const grant = this.preauthorizations.consume({ token, contextId, gameId, ...identity, now })
        this.states.set(contextId, { status: 'running', identity, gameId, grant })
        return { status: 'running', grant: { ...grant } }
      } catch (error) {
        this.states.set(contextId, { status: 'failed', identity, gameId, error })
        return { status: 'failed', error }
      }
    })
  }

  reconcileIndeterminate(contextId) {
    return this.#serial(contextId, async () => {
      const state = this.states.get(contextId)
      if (!state || state.status !== 'indeterminate' || !state.grant) return { status: state?.status ?? 'none' }
      const observed = await this.reconcile({ contextId, identity: { ...state.identity }, grant: { ...state.grant } })
      if (observed && sameIdentity(observed, state.identity) && await this.finalPolicy({ contextId, gameId: state.gameId, ...state.identity, now: Date.now() })) { state.status = 'running'; return { status: 'running' } }
      state.status = 'failed'
      return { status: 'failed' }
    })
  }

  processExited({ contextId, processId, processStartedAt }) {
    return this.#serial(contextId, async () => {
      const state = this.states.get(contextId)
      if (!state?.identity || !sameIdentity(state.identity, { processId, processStartedAt })) return { status: 'ignored' }
      state.status = 'exited'
      return { status: 'exited' }
    })
  }
}
