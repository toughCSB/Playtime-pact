import { describe, expect, it, vi } from 'vitest'

const nativeHarness = vi.hoisted(() => ({ writeCalls: 0 }))

vi.mock('koffi', () => {
  const functionName = (declaration) => /\b([A-Za-z0-9_]+)\s*\(/.exec(declaration)?.[1]
  const api = (declaration) => {
    const name = functionName(declaration)
    if (name === 'CreateFileW') return () => 1n
    if (name === 'GetNamedPipeServerProcessId') return (_handle, processId) => {
      processId.writeUInt32LE(4242)
      return true
    }
    if (name === 'OpenProcess') return () => 2n
    if (name === 'QueryFullProcessImageNameW') return (_process, _flags, image, length) => {
      const encoded = Buffer.from(process.execPath, 'utf16le')
      encoded.copy(image)
      length.writeUInt32LE(process.execPath.length)
      return true
    }
    if (name === 'WriteFile') {
      const write = () => false
      write.async = (_handle, _output, _length, _written, _overlapped, callback) => {
        nativeHarness.writeCalls += 1
        queueMicrotask(() => callback(null, false))
      }
      return write
    }
    if (name === 'CancelIoEx' || name === 'CloseHandle') return () => true
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

describe('native privileged transport diagnostics', () => {
  it('tags a native WriteFile completion failure at the request-write boundary', async () => {
    const { PrivilegedBrokerClient, namedPipeTransport } = await import('../src/main/remoteApproval/privilegedService')
    const { formatPrivilegedHealthDiagnostic } = await import('../src/main/remoteApproval/privilegedHealthDiagnostic')
    const client = new PrivilegedBrokerClient(namedPipeTransport('\\\\.\\pipe\\controlled-write-failure', 1_000, false))

    const error = await client.healthCheck().catch((cause) => cause)

    expect(nativeHarness.writeCalls).toBe(1)
    expect(formatPrivilegedHealthDiagnostic(error)).toBe(
      'PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=request-write code=REQUEST_WRITE_FAILED\n',
    )
  })
})
