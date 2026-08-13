const OAUTH_AUDIENCE = 'https://oauth2.googleapis.com/token'
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_ENDPOINT = OAUTH_AUDIENCE
const TOKEN_REFRESH_SKEW_MS = 60_000

const encoder = new TextEncoder()
const fail = (code, retryable) => Object.assign(new Error(code), { code, retryable })
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const encodeJson = (value) => base64url(encoder.encode(JSON.stringify(value)))

function requiredString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function pkcs8Bytes(pem) {
  const body = requiredString('privateKey', pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new TypeError('privateKey must be a PKCS#8 PEM private key')
  try { return Uint8Array.from(atob(body), (character) => character.charCodeAt(0)) }
  catch { throw new TypeError('privateKey must be a PKCS#8 PEM private key') }
}

async function parseJson(response) {
  let text
  try { text = await response.text() } catch { return null }
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function fcmErrorCode(body) {
  const details = body?.error?.details
  if (!Array.isArray(details)) return null
  const detail = details.find((value) => value && typeof value === 'object' && typeof value.errorCode === 'string')
  return detail?.errorCode ?? null
}

/** Direct Firebase Cloud Messaging HTTP v1 sender. */
export function createFcmProvider({
  projectId,
  clientEmail,
  privateKey,
  fetchImpl = fetch,
  now = () => Date.now(),
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  fcmEndpoint,
} = {}) {
  projectId = requiredString('projectId', projectId)
  clientEmail = requiredString('clientEmail', clientEmail)
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  tokenEndpoint = requiredString('tokenEndpoint', tokenEndpoint)
  fcmEndpoint = fcmEndpoint ?? `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
  fcmEndpoint = requiredString('fcmEndpoint', fcmEndpoint)
  const keyBytes = pkcs8Bytes(privateKey)
  const keyPromise = crypto.subtle.importKey('pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  let cachedToken = null
  let tokenPromise = null

  const serviceAccountAssertion = async () => {
    const issuedAt = Math.floor(now() / 1000)
    const header = encodeJson({ alg: 'RS256', typ: 'JWT' })
    const claims = encodeJson({ iss: clientEmail, scope: OAUTH_SCOPE, aud: OAUTH_AUDIENCE, iat: issuedAt, exp: issuedAt + 3600 })
    const signingInput = `${header}.${claims}`
    let signature
    try {
      const key = await keyPromise
      signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput)))
    } catch {
      throw fail('FCM_CREDENTIAL_INVALID', false)
    }
    return `${signingInput}.${base64url(signature)}`
  }

  const fetchAccessToken = async () => {
    let response
    try {
      const assertion = await serviceAccountAssertion()
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      })
    } catch (error) {
      if (error?.code === 'FCM_CREDENTIAL_INVALID') throw error
      throw fail('FCM_RETRYABLE', true)
    }
    const body = await parseJson(response)
    if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw fail('FCM_RETRYABLE', true)
    }
    cachedToken = { value: body.access_token, expiresAtMs: now() + body.expires_in * 1000 }
    return cachedToken.value
  }

  const accessToken = async (forceRefresh = false) => {
    if (forceRefresh) cachedToken = null
    if (cachedToken && now() < cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) return cachedToken.value
    if (!tokenPromise) tokenPromise = fetchAccessToken().finally(() => { tokenPromise = null })
    return tokenPromise
  }

  const postMessage = async (token, intentId, forceRefresh) => {
    let response
    try {
      const bearer = await accessToken(forceRefresh)
      response = await fetchImpl(fcmEndpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, data: { intentId } } }),
      })
    } catch (error) {
      if (error?.code) throw error
      throw fail('FCM_RETRYABLE', true)
    }
    const body = await parseJson(response)
    return { response, body }
  }

  return {
    async send({ token, intentId }) {
      requiredString('token', token)
      requiredString('intentId', intentId)
      let result = await postMessage(token, intentId, false)
      if (result.response.status === 401) {
        result = await postMessage(token, intentId, true)
        if (result.response.status === 401) throw fail('FCM_AUTH_FAILED', false)
      }
      if (result.response.ok) {
        if (typeof result.body?.name !== 'string' || !result.body.name || result.body.name.length > 512) throw fail('FCM_RETRYABLE', true)
        return result.body.name
      }
      const status = result.response.status
      const providerCode = fcmErrorCode(result.body)
      if (providerCode === 'UNREGISTERED' || providerCode === 'INVALID_ARGUMENT') throw fail('FCM_DEVICE_TOKEN_INVALID', false)
      if (status === 429 || status >= 500) throw fail('FCM_RETRYABLE', true)
      throw fail('FCM_REJECTED', false)
    },
  }
}
