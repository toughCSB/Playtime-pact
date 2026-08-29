import { describe, expect, it, vi } from 'vitest'

const nativeHarness = vi.hoisted(() => ({
  connect: null,
  disconnected: null,
  operations: [],
  request: Buffer.alloc(0),
}))

vi.mock('koffi', () => {
  const functionName = (declaration) => /\b([A-Za-z0-9_]+)\s*\(/.exec(declaration)?.[1]
  const api = (declaration) => {
    const name = functionName(declaration)
    if (name === 'ConvertStringSecurityDescriptorToSecurityDescriptorW') {
      return (_sddl, _revision, descriptor) => { descriptor[0] = 1n; return true }
    }
    if (name === 'CreateNamedPipeW') return () => 2n
    if (name === 'ConnectNamedPipe') {
      const connect = () => false
      connect.async = (_handle, _overlapped, callback) => { nativeHarness.connect = callback }
      return connect
    }
    if (name === 'GetNamedPipeClientProcessId') {
      return (_handle, processId) => { processId.writeUInt32LE(process.pid); return true }
    }
    if (name === 'OpenProcess') return () => 3n
    if (name === 'QueryFullProcessImageNameW') {
      return (_process, _flags, image, length) => {
        Buffer.from(process.execPath, 'utf16le').copy(image)
        length.writeUInt32LE(process.execPath.length)
        return true
      }
    }
    if (name === 'ReadFile') {
      const read = () => false
      read.async = (_handle, input, _length, bytesRead, _overlapped, callback) => {
        nativeHarness.request.copy(input)
        bytesRead.writeUInt32LE(nativeHarness.request.length)
        queueMicrotask(() => callback(null, true))
      }
      return read
    }
    if (name === 'WriteFile') {
      const write = () => false
      write.async = (_handle, _output, length, bytesWritten, _overlapped, callback) => {
        nativeHarness.operations.push('write')
        bytesWritten.writeUInt32LE(length)
        queueMicrotask(() => callback(null, true))
      }
      return write
    }
    if (name === 'FlushFileBuffers') return () => { nativeHarness.operations.push('flush'); return true }
    if (name === 'DisconnectNamedPipe') {
      return () => {
        nativeHarness.operations.push('disconnect')
        nativeHarness.disconnected?.()
        return true
      }
    }
    if (name === 'CancelIoEx' || name === 'CloseHandle' || name === 'LocalFree') return () => true
    return Object.assign(() => false, { async: (...args) => queueMicrotask(() => args.at(-1)?.(null, false)) })
  }
  return {
    default: {
      load: () => ({ func: api }),
      struct: () => ({}),
      sizeof: () => 24,
    },
  }
})

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

describe('native privileged server response delivery', () => {
  it('flushes a completed response before disconnecting the named pipe', async () => {
    // Given: an authenticated native client has sent a health request.
    const { PrivilegedApprovalService, startPrivilegedPipeServer } = await import('../src/main/remoteApproval/privilegedService')
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} })
    nativeHarness.operations = []
    nativeHarness.request = frame({
      capability: 'accounting',
      purpose: 'start-accounting',
      nonce: 'flush-response-01',
      operation: 'health-check',
      payload: {},
    })
    const disconnected = new Promise((resolve) => { nativeHarness.disconnected = resolve })
    const server = await startPrivilegedPipeServer(service, '\\\\.\\pipe\\flush-response-test')

    try {
      // When: the server accepts and completes that request.
      nativeHarness.connect?.(null, true)
      await Promise.race([
        disconnected,
        new Promise((_, reject) => setTimeout(() => reject(new Error('named-pipe disconnect timeout')), 1_000)),
      ])

      // Then: durable delivery is ordered before disconnect.
      expect(nativeHarness.operations).toEqual(['write', 'flush', 'disconnect'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
