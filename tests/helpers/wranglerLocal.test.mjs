import { describe, expect, it, vi } from 'vitest'

import { createWranglerOutputCapture, createWranglerReadinessDetector } from './wranglerLocal.mjs'

describe('Wrangler local readiness', () => {
  it('preserves callback arrival order across stdout and stderr', () => {
    const ready = vi.fn()
    const capture = createWranglerOutputCapture(createWranglerReadinessDetector(ready))

    capture.stderr('[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (1ms)\n')
    capture.stdout('[wrangler-ProxyWorker:info] Ready on http://127.0.0.1:12345\n')
    expect(ready).not.toHaveBeenCalled()

    capture.stderr('[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (2ms)\n')
    expect(ready).toHaveBeenCalledOnce()
    expect(ready).toHaveBeenCalledWith('http://127.0.0.1:12345')
    expect(capture.output()).toEqual({
      stdout: '[wrangler-ProxyWorker:info] Ready on http://127.0.0.1:12345\n',
      stderr: '[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (1ms)\n[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (2ms)\n',
    })
  })

  it('waits for proxy routing activation when the banner precedes serving', () => {
    const ready = vi.fn()
    const inspect = createWranglerReadinessDetector(ready)

    inspect('[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (1ms)\n[wrangler-ProxyWorker:info] Ready on http://127.0.0.1:12345\n')
    expect(ready).not.toHaveBeenCalled()

    inspect('[wrangler-ProxyWorker:info] Ready on http://127.0.0.1:12345\n[wrangler-ProxyWorker:info] GET /cdn-cgi/ProxyWorker/play 204 No Content (2ms)\n')
    expect(ready).toHaveBeenCalledOnce()
    expect(ready).toHaveBeenCalledWith('http://127.0.0.1:12345')
  })
})
