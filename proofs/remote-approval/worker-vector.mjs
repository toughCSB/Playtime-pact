import { FlattenedSign, flattenedVerify, importJWK } from 'jose'

const vector = {
  publicJwk: { kty: 'EC', crv: 'P-256', x: 'RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM', y: 'IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A' },
  privateJwk: { kty: 'EC', crv: 'P-256', x: 'RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM', y: 'IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A', d: 'eRQrsh696y6g8TNSrZgQx8WiDxqTs620Ue9L6XNapJU' },
  proof: {
    protected: 'eyJhbGciOiJFUzI1NiIsImp3ayI6eyJrdHkiOiJFQyIsIngiOiJSRDV5MFd5RmNSQzB5NlVwdVZqUDVCaHBhSmV5ZE9XRmFXS09qOGdSR1dNIiwieSI6IklpTXk3U3hqTmJzdllfYWdtX0x3ZW9falRlZHVjR0ZwUzVTV3Z4T2pkNEEiLCJjcnYiOiJQLTI1NiJ9LCJ0eXAiOiJyZW1vdGUtYXBwcm92YWwrandzIn0',
    payload: 'eyJhY3RvcklkIjoicGFyZW50LXZlY3RvciIsImNvbnRlbnREaWdlc3QiOiJzaGEtMjU2PTp5Z28zdGFuSFZ5TE84MUdST1ZNcEhHQ05XT3dKK3puQjZLaVJnUVNDbVl3PToiLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9hcHByb3ZhbC5leGFtcGxlL3YxL3JlcXVlc3RzL3IxL3Jlc3BvbmQiLCJpYXQiOjQwMDAsImlkZW1wb3RlbmN5S2V5IjoiaWRlbXBvdGVuY3ktdmVjdG9yLTAwMDEiLCJqdGkiOiJqdGktdmVjdG9yLTAwMDEiLCJtZW1iZXJzaGlwRXBvY2giOjMsIm5vbmNlIjoibm9uY2UtdmVjdG9yLTAwMDEiLCJzZXJ2aWNlRXBvY2giOjh9',
    signature: 'oMW_tE4_aBvjKzbMjnx68FrJpm1Y4l3gvJtjV81YTrJwUF3DcC4jQVtpP1lzLpApEeAWRc6KRBukgGftspxNNA',
  },
}

export default {
  async fetch() {
    const publicKey = await importJWK(vector.publicJwk, 'ES256')
    await flattenedVerify(vector.proof, publicKey, { algorithms: ['ES256'] })
    const privateKey = await importJWK(vector.privateJwk, 'ES256')
    const payload = new TextEncoder().encode('worker-signing-direction')
    const signed = await new FlattenedSign(payload).setProtectedHeader({ alg: 'ES256' }).sign(privateKey)
    await flattenedVerify(signed, publicKey, { algorithms: ['ES256'] })
    return Response.json({ schemaVersion: 1, runtime: 'cloudflare-worker', vectorVerified: true, workerSignVerify: true })
  },
}
