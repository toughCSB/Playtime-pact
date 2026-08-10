import { createPrivateKey, createPublicKey } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequestProof } from './auth-vector.mjs'

const privateJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM',
  y: 'IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A',
  d: 'eRQrsh696y6g8TNSrZgQx8WiDxqTs620Ue9L6XNapJU',
}
const privateKey = createPrivateKey({ key: privateJwk, format: 'jwk' })
const publicKey = createPublicKey(privateKey)
const request = {
  method: 'POST',
  url: 'https://approval.example/v1/requests/r1/respond',
  body: '{"decision":"approve","minutes":20}',
  actorId: 'parent-vector',
  membershipEpoch: 3,
  serviceEpoch: 8,
  nonce: 'nonce-vector-0001',
  idempotencyKey: 'idempotency-vector-0001',
  nowSeconds: 4_000,
  jti: 'jti-vector-0001',
}
const proof = await createRequestProof({ privateKey, publicKey, ...request })
const vector = {
  schemaVersion: 1,
  library: { name: 'jose', version: '6.2.8' },
  algorithm: 'ES256',
  testOnlyPrivateJwk: privateJwk,
  publicJwk: publicKey.export({ format: 'jwk' }),
  request,
  proof,
}
await writeFile(new URL('./auth-golden-vector.json', import.meta.url), `${JSON.stringify(vector, null, 2)}\n`)
