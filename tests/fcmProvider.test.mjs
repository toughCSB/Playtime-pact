import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createFcmProvider } from '../remote-backend/src/fcmProvider.mjs'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const TOKEN_URL = 'http://127.0.0.1:39001/token'
const FCM_URL = 'http://127.0.0.1:39001/v1/projects/test-project/messages:send'

const response = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

function harness(steps, start = 1_700_000_000_000) {
  let now = start
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const step = steps.shift()
    assert.ok(step, `unexpected external call to ${url}`)
    assert.equal(String(url), step.url)
    if (step.throw) throw step.throw
    return response(step.status, step.body)
  }
  const provider = createFcmProvider({
    projectId: 'test-project',
    clientEmail: 'worker@test-project.iam.gserviceaccount.com',
    privateKey: privateKeyPem,
    fetchImpl,
    now: () => now,
    tokenEndpoint: TOKEN_URL,
    fcmEndpoint: FCM_URL,
  })
  return { provider, calls, setNow(value) { now = value } }
}

const tokenStep = (accessToken = 'access-1', expiresIn = 3600) => ({
  url: TOKEN_URL,
  status: 200,
  body: { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn },
})
const sendStep = (status = 200, body = { name: 'projects/test-project/messages/receipt-1' }) => ({ url: FCM_URL, status, body })

function jwtClaims(call) {
  const form = new URLSearchParams(call.init.body)
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  const [header, payload] = form.get('assertion').split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  }
}

test('direct FCM v1 send signs a service-account JWT and returns the provider message name', async () => {
  const h = harness([tokenStep(), sendStep()])
  const receipt = await h.provider.send({ token: 'device-token', intentId: 'request:one' })

  assert.equal(receipt, 'projects/test-project/messages/receipt-1')
  assert.equal(h.calls.length, 2)
  const claims = jwtClaims(h.calls[0])
  assert.deepEqual(claims.header, { alg: 'RS256', typ: 'JWT' })
  assert.equal(claims.payload.iss, 'worker@test-project.iam.gserviceaccount.com')
  assert.equal(claims.payload.scope, 'https://www.googleapis.com/auth/firebase.messaging')
  assert.equal(claims.payload.aud, 'https://oauth2.googleapis.com/token')
  assert.equal(claims.payload.exp - claims.payload.iat, 3600)
  assert.equal(h.calls[1].init.headers.authorization, 'Bearer access-1')
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { message: { token: 'device-token', data: { intentId: 'request:one' } } })
})

test('access token cache is reused but refreshed at the 60 second stale boundary', async () => {
  const h = harness([tokenStep('access-1', 120), sendStep(), sendStep(), tokenStep('access-2', 120), sendStep()])
  await h.provider.send({ token: 'device-1', intentId: 'one' })
  h.setNow(1_700_000_059_999)
  await h.provider.send({ token: 'device-2', intentId: 'two' })
  h.setNow(1_700_000_060_000)
  await h.provider.send({ token: 'device-3', intentId: 'three' })

  assert.deepEqual(h.calls.filter((call) => call.url === TOKEN_URL).map((call) => jwtClaims(call).payload.iat), [1_700_000_000, 1_700_000_060])
  assert.equal(h.calls.at(-1).init.headers.authorization, 'Bearer access-2')
})

test('FCM 401 invalidates OAuth cache and refreshes exactly once', async () => {
  const h = harness([tokenStep('stale'), sendStep(401, { error: { status: 'UNAUTHENTICATED' } }), tokenStep('fresh'), sendStep()])
  assert.equal(await h.provider.send({ token: 'device-token', intentId: 'intent' }), 'projects/test-project/messages/receipt-1')
  assert.deepEqual(h.calls.map((call) => call.url), [TOKEN_URL, FCM_URL, TOKEN_URL, FCM_URL])
  assert.equal(h.calls.at(-1).init.headers.authorization, 'Bearer fresh')
})

test('a second FCM 401 is terminal and never loops', async () => {
  const h = harness([tokenStep('first'), sendStep(401, {}), tokenStep('second'), sendStep(401, {})])
  await assert.rejects(() => h.provider.send({ token: 'device-token', intentId: 'intent' }), (error) => error.code === 'FCM_AUTH_FAILED' && error.retryable === false)
  assert.equal(h.calls.length, 4)
})

test('429, 5xx, network errors, and malformed success bodies are retryable', async () => {
  for (const send of [
    sendStep(429, { error: { status: 'RESOURCE_EXHAUSTED' } }),
    sendStep(503, '<html>down</html>'),
    { url: FCM_URL, throw: new Error('socket reset') },
    sendStep(200, { unexpected: true }),
  ]) {
    const h = harness([tokenStep(), send])
    await assert.rejects(() => h.provider.send({ token: 'device-token', intentId: 'intent' }), (error) => error.code === 'FCM_RETRYABLE' && error.retryable === true)
    assert.equal(h.calls.length, 2)
  }
})

test('UNREGISTERED and INVALID_ARGUMENT device token responses are terminal', async () => {
  for (const errorCode of ['UNREGISTERED', 'INVALID_ARGUMENT']) {
    const h = harness([tokenStep(), sendStep(400, { error: { status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } })])
    await assert.rejects(() => h.provider.send({ token: 'device-token', intentId: 'intent' }), (error) => error.code === 'FCM_DEVICE_TOKEN_INVALID' && error.retryable === false)
  }
})

test('malformed OAuth responses fail retryably without leaking private key material', async () => {
  for (const body of [{ access_token: '', expires_in: 3600 }, { access_token: 'x', expires_in: 'forever' }, '<html>bad gateway</html>']) {
    const h = harness([{ url: TOKEN_URL, status: 200, body }])
    await assert.rejects(
      () => h.provider.send({ token: 'device-token', intentId: 'intent' }),
      (error) => error.code === 'FCM_RETRYABLE' && error.retryable === true && !String(error.stack).includes(String(privateKeyPem)),
    )
  }
})

test('configuration rejects missing service-account fields without making traffic', () => {
  for (const missing of ['projectId', 'clientEmail', 'privateKey']) {
    const options = { projectId: 'project', clientEmail: 'worker@example.com', privateKey: privateKeyPem, fetchImpl: async () => assert.fail('traffic') }
    delete options[missing]
    assert.throws(() => createFcmProvider(options), new RegExp(missing))
  }
})
