import { createAuthenticator } from '../../remote-backend/src/authenticator.mjs'
import { createWorker } from '../../remote-backend/src/worker.mjs'

let currentNowMs
let consumeBarrierUrl

function armConsumeBarrier(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new TypeError('consume barrier must be a loopback HTTP URL')
  consumeBarrierUrl = parsed.toString()
}

async function enterConsumePreCommitBarrier() {
  const url = consumeBarrierUrl
  if (!url) return
  consumeBarrierUrl = undefined
  console.log('PLAYTIME_PACT_TEST_CONSUME_PRE_COMMIT_REACHED')
  const response = await fetch(url)
  if (response.status !== 204) throw new Error(`consume barrier release failed: ${response.status}`)
}

function configuredNow(env) {
  if (currentNowMs === undefined) currentNowMs = Number(env.TEST_NOW_MS)
  if (!Number.isSafeInteger(currentNowMs) || currentNowMs < 0) throw new TypeError('TEST_NOW_MS must be a non-negative safe integer')
  return currentNowMs
}

function workerFor(env) {
  configuredNow(env)
  const shippedAuthenticator = createAuthenticator(env.DB, {
    now: () => currentNowMs,
    setupAuthorityId: env.SETUP_AUTHORITY_ID || 'setup-local',
    minimumParentClientVersion: Number(env.MINIMUM_PARENT_CLIENT_VERSION),
  })
  const authenticator = {
    async verify(input) {
      const proof = await shippedAuthenticator.verify(input)
      if (new URL(input.canonicalUrl).pathname === '/v1/consume') await enterConsumePreCommitBarrier()
      return proof
    },
  }
  const encryptionKey = typeof env.FCM_TOKEN_ENCRYPTION_KEY === 'string'
    ? Uint8Array.from(atob(env.FCM_TOKEN_ENCRYPTION_KEY), (character) => character.charCodeAt(0))
    : undefined
  const notificationProvider = env.TEST_PROVIDER_FAILURE === 'true'
    ? { async send() { throw Object.assign(new Error('injected local provider outage'), { code: 'PROVIDER_TRANSIENT', retryable: true }) } }
    : { async send({ intentId }) { return `local:${intentId}` } }
  return createWorker({
    db: env.DB,
    authenticator,
    now: () => currentNowMs,
    pairingTokenSecret: env.PAIRING_TOKEN_SECRET,
    fcmTokenEncryptionKey: encryptionKey,
    notificationProvider,
  })
}

export default {
  async fetch(request, env) {
    configuredNow(env)
    const url = new URL(request.url)
    if (url.pathname === '/__test/clock' && request.method === 'PUT') {
      const next = Number((await request.json()).nowMs)
      if (!Number.isSafeInteger(next) || next < currentNowMs) return Response.json({ error: 'INVALID_TEST_CLOCK' }, { status: 400 })
      currentNowMs = next
      return Response.json({ nowMs: currentNowMs })
    }
    if (url.pathname === '/__test/consume-barrier' && request.method === 'PUT') {
      armConsumeBarrier((await request.json()).url)
      return Response.json({ state: 'armed' })
    }
    return workerFor(env).fetch(request)
  },
  scheduled(_event, env) { return workerFor(env).scheduled() },
}
