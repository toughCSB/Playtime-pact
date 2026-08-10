const encoder = new TextEncoder()
const canonical = (value) => JSON.stringify(value)
const equalWater = (left, right) => left?.sequence === right?.sequence && left?.allowanceVersion === right?.allowanceVersion && left?.signature === right?.signature
const clone = (value) => structuredClone(value)

function validHighWater(value) {
  return value && Number.isInteger(value.sequence) && value.sequence >= 0 && Number.isInteger(value.allowanceVersion) && value.allowanceVersion >= 0 && (value.sequence === 0 ? value.signature === null : typeof value.signature === 'string')
}
function validDebit(entry) {
  return entry && Number.isInteger(entry.sequence) && entry.sequence > 0 && Number.isInteger(entry.allowanceVersion) && entry.allowanceVersion > 0 && typeof entry.domain === 'string' && entry.domain.length > 0 && Number.isInteger(entry.debitSeconds) && entry.debitSeconds > 0 && typeof entry.requestId === 'string' && entry.requestId.length > 0 && (entry.priorSignature === null || typeof entry.priorSignature === 'string') && typeof entry.signature === 'string'
}
function unsignedEntry(entry) { const { signature, ...payload } = entry; return payload }

export function assertAccountingAdapters({ persistence, highWaterAnchor, signer }) {
  if (!persistence || typeof persistence.recover !== 'function' || typeof persistence.prepare !== 'function' || typeof persistence.commit !== 'function' || typeof persistence.abort !== 'function') throw new Error('Prepare/commit/recovery persistence adapter required')
  if (!highWaterAnchor || typeof highWaterAnchor.read !== 'function' || typeof highWaterAnchor.compareAndSwap !== 'function') throw new Error('Authenticated high-water compare-and-swap anchor required')
  if (!signer || typeof signer.sign !== 'function' || typeof signer.verify !== 'function' || signer.nonExportable !== true || typeof signer.keyId !== 'string' || signer.keyId.length === 0 || 'privateKey' in signer || typeof signer.exportPrivateKey === 'function') throw new Error('Non-exportable identified CNG signer required')
}

export class ProtectedAccountingJournal {
  static async open(adapters) {
    assertAccountingAdapters(adapters)
    const recovered = await adapters.persistence.recover()
    if (!recovered || !recovered.committed || !Array.isArray(recovered.committed.entries) || !validHighWater(recovered.committed.highWater)) throw new Error('Journal recovery evidence unavailable')
    const anchor = await adapters.highWaterAnchor.read()
    if (!validHighWater(anchor)) throw new Error('Authenticated high-water unavailable')
    let committed = recovered.committed
    if (recovered.prepared) {
      if (!recovered.prepared.id || !recovered.prepared.snapshot) throw new Error('Invalid prepared journal record')
      if (equalWater(anchor, recovered.prepared.snapshot.highWater)) {
        await adapters.persistence.commit(recovered.prepared.id)
        committed = recovered.prepared.snapshot
      } else if (equalWater(anchor, committed.highWater)) {
        await adapters.persistence.abort(recovered.prepared.id)
      } else throw new Error('Prepared journal recovery conflict')
    }
    if (!equalWater(anchor, committed.highWater)) throw new Error('Journal truncated, tampered, or not externally anchored')
    const journal = new ProtectedAccountingJournal(adapters, committed)
    await journal.#verify()
    return journal
  }

  constructor(adapters, snapshot) {
    this.persistence = adapters.persistence
    this.highWaterAnchor = adapters.highWaterAnchor
    this.signer = adapters.signer
    this.entries = snapshot.entries.map((entry) => Object.freeze({ ...entry }))
    this.highWater = Object.freeze({ ...snapshot.highWater })
    this.lastAllowanceVersionByDomain = new Map()
    this.byRequestId = new Map()
    this.tail = Promise.resolve()
    this.poisoned = false
  }

  async #verify() {
    let previousSignature = null
    let highVersion = 0
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      if (!validDebit(entry) || entry.sequence !== index + 1 || entry.priorSignature !== previousSignature || !(await this.signer.verify(encoder.encode(canonical(unsignedEntry(entry))), entry.signature))) throw new Error('Journal chain or signature invalid')
      const priorVersion = this.lastAllowanceVersionByDomain.get(entry.domain) ?? 0
      if (entry.allowanceVersion < priorVersion) throw new Error('Allowance version rollback')
      if (this.byRequestId.has(entry.requestId)) throw new Error('Duplicate request id in journal')
      this.lastAllowanceVersionByDomain.set(entry.domain, entry.allowanceVersion)
      this.byRequestId.set(entry.requestId, entry)
      highVersion = Math.max(highVersion, entry.allowanceVersion)
      previousSignature = entry.signature
    }
    if (!equalWater(this.highWater, { sequence: this.entries.length, allowanceVersion: highVersion, signature: previousSignature })) throw new Error('Journal high-water mismatch')
  }

  snapshot() { return Object.freeze({ entries: this.entries.map((entry) => ({ ...entry })), highWater: { ...this.highWater } }) }
  append(input) {
    const run = this.tail.catch(() => undefined).then(() => {
      if (this.poisoned) throw new Error('Journal instance poisoned; reopen for recovery')
      return this.#append(input)
    })
    this.tail = run
    return run
  }

  async #append({ allowanceVersion, domain, debitSeconds, requestId }) {
    if (!Number.isInteger(allowanceVersion) || allowanceVersion <= 0 || typeof domain !== 'string' || domain.length === 0 || !Number.isInteger(debitSeconds) || debitSeconds <= 0 || typeof requestId !== 'string' || requestId.length === 0) throw new Error('Invalid debit')
    const existing = this.byRequestId.get(requestId)
    if (existing) {
      if (existing.allowanceVersion === allowanceVersion && existing.domain === domain && existing.debitSeconds === debitSeconds) return { ...existing }
      throw new Error('Request id conflict')
    }
    if (allowanceVersion < (this.lastAllowanceVersionByDomain.get(domain) ?? 0)) throw new Error('Allowance version rollback')
    const payload = { sequence: this.entries.length + 1, allowanceVersion, domain, debitSeconds, requestId, priorSignature: this.highWater.signature }
    const signature = await this.signer.sign(encoder.encode(canonical(payload)))
    if (typeof signature !== 'string' || signature.length === 0) throw new Error('CNG signer failed')
    const entry = Object.freeze({ ...payload, signature })
    const nextWater = Object.freeze({ sequence: entry.sequence, allowanceVersion: Math.max(this.highWater.allowanceVersion, allowanceVersion), signature })
    const snapshot = { entries: [...this.entries, entry].map((value) => ({ ...value })), highWater: { ...nextWater } }
    const recoveryState = await this.persistence.recover()
    if (recoveryState?.prepared) throw new Error('Outstanding prepare is owned by recovery')
    const prepared = await this.persistence.prepare(clone(snapshot))
    if (!prepared?.id) throw new Error('Journal prepare failed')
    let anchored = false
    try {
      anchored = await this.highWaterAnchor.compareAndSwap({ ...this.highWater }, { ...nextWater })
      if (!anchored) throw new Error('High-water compare-and-swap failed')
      await this.persistence.commit(prepared.id)
    } catch (error) {
      if (!anchored) await this.persistence.abort(prepared.id)
      else this.poisoned = true
      throw error
    }
    this.entries = [...this.entries, entry]
    this.highWater = nextWater
    this.lastAllowanceVersionByDomain.set(domain, allowanceVersion)
    this.byRequestId.set(requestId, entry)
    return { ...entry }
  }
}
