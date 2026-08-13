import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeHarness = vi.hoisted(() => ({
  closed: [],
  configPath: '',
  configQueryFailure: false,
  configPointerOutsideBuffer: false,
  queryServiceConfigFixture: null,
  getPipePids: [300, 300],
  images: new Map(),
  lastError: 0,
  managerAvailable: true,
  parentProcessId: 200,
  serviceAvailable: true,
  serviceName: 'PlaytimePactPrivilegedBroker',
  statusPids: [200, 200],
  statusState: 4,
  writeCalls: 0,
}))

vi.mock('koffi', () => {
  const addresses = new WeakMap()
  let nextAddress = 0x10000000n
  const address = (buffer) => {
    let value = addresses.get(buffer)
    if (value === undefined) {
      value = nextAddress
      nextAddress += 0x10000n
      addresses.set(buffer, value)
    }
    return value
  }
  const functionName = (declaration) => /\b([A-Za-z0-9_]+)\s*\(/.exec(declaration)?.[1]
  const api = (declaration) => {
    const name = functionName(declaration)
    if (name === 'CreateFileW') return () => 1n
    if (name === 'GetNamedPipeServerProcessId') return (_handle, processId) => {
      processId.writeUInt32LE(nativeHarness.getPipePids.shift() ?? 0)
      return processId.readUInt32LE(0) !== 0
    }
    if (name === 'OpenProcess') return (_access, _inherit, processId) => nativeHarness.images.has(processId) ? BigInt(1000 + processId) : 0n
    if (name === 'QueryFullProcessImageNameW') return (handle, _flags, image, length) => {
      const value = nativeHarness.images.get(Number(handle) - 1000)
      if (!value) return false
      Buffer.from(value, 'utf16le').copy(image)
      length.writeUInt32LE(value.length)
      return true
    }
    if (name === 'OpenSCManagerW') return () => nativeHarness.managerAvailable ? 10n : 0n
    if (name === 'OpenServiceW') return (_manager, serviceName) => nativeHarness.serviceAvailable && serviceName === nativeHarness.serviceName ? 11n : 0n
    if (name === 'QueryServiceStatusEx') return (_service, _level, status) => {
      const processId = nativeHarness.statusPids.shift() ?? 0
      status.writeUInt32LE(nativeHarness.statusState, 4)
      status.writeUInt32LE(processId, 28)
      return true
    }
    if (name === 'QueryServiceConfigW') return (_service, config, size, needed) => {
      if (nativeHarness.queryServiceConfigFixture) {
        return nativeHarness.queryServiceConfigFixture(config, size, needed, address)
      }
      const encoded = Buffer.from(`${nativeHarness.configPath}\0`, 'utf16le')
      const required = 64 + encoded.length
      needed.writeUInt32LE(required)
      if (!config || size === 0) {
        nativeHarness.lastError = nativeHarness.configQueryFailure ? 5 : 122
        return false
      }
      if (nativeHarness.configQueryFailure) return false
      const pointer = nativeHarness.configPointerOutsideBuffer ? address(config) + BigInt(required + 8) : address(config) + 64n
      config.writeBigUInt64LE(pointer, 16)
      encoded.copy(config, 64)
      return true
    }
    if (name === 'GetLastError') return () => nativeHarness.lastError
    if (name === 'CreateToolhelp32Snapshot') return () => 12n
    if (name === 'Process32FirstW') return (_snapshot, entry) => {
      entry.th32ProcessID = nativeHarness.getPipePids[0] ?? 300
      entry.th32ParentProcessID = nativeHarness.parentProcessId
      return true
    }
    if (name === 'Process32NextW') return () => false
    if (name === 'WriteFile') {
      const write = () => false
      write.async = (_handle, _output, _length, _written, _overlapped, callback) => {
        nativeHarness.writeCalls += 1
        queueMicrotask(() => callback(null, false))
      }
      return write
    }
    if (name === 'CancelIoEx') return () => true
    if (name === 'CloseHandle') return (handle) => { nativeHarness.closed.push(handle); return true }
    return Object.assign(() => false, { async: (...args) => queueMicrotask(() => args.at(-1)?.(null, false)) })
  }
  return {
    default: {
      address,
      load: () => ({ func: api }),
      struct: (_name, definition) => definition,
      sizeof: () => 24,
    },
  }
})

const expectedWrapper = join(dirname(process.execPath), 'PlaytimePactPrivilegedBroker.exe')

// Independently follows the documented x64 QUERY_SERVICE_CONFIGW ABI:
// lpBinaryPathName is the pointer at offset 16 in a 64-byte structure.
function canonicalX64QueryServiceConfigFixture(binaryPath) {
  return (config, size, needed, address) => {
    const encoded = Buffer.from(`${binaryPath}\0`, 'utf16le')
    const required = 64 + encoded.length
    needed.writeUInt32LE(required)
    if (!config || size === 0) {
      nativeHarness.lastError = 122
      return false
    }
    config.writeBigUInt64LE(address(config) + 64n, 16)
    encoded.copy(config, 64)
    return true
  }
}

beforeEach(() => {
  nativeHarness.closed = []
  nativeHarness.configPath = `"${expectedWrapper}"`
  nativeHarness.configQueryFailure = false
  nativeHarness.configPointerOutsideBuffer = false
  nativeHarness.queryServiceConfigFixture = null
  nativeHarness.getPipePids = [300, 300]
  nativeHarness.images = new Map()
  nativeHarness.lastError = 0
  nativeHarness.managerAvailable = true
  nativeHarness.parentProcessId = 200
  nativeHarness.serviceAvailable = true
  nativeHarness.serviceName = 'PlaytimePactPrivilegedBroker'
  nativeHarness.statusPids = [200, 200, 200, 200]
  nativeHarness.statusState = 4
  nativeHarness.writeCalls = 0
})

async function diagnostic(pipe, requireServiceIdentity) {
  const { PrivilegedBrokerClient, namedPipeTransport } = await import('../src/main/remoteApproval/privilegedService')
  const { formatPrivilegedHealthDiagnostic } = await import('../src/main/remoteApproval/privilegedHealthDiagnostic')
  const transport = pipe === undefined ? namedPipeTransport() : namedPipeTransport(pipe, 1_000, requireServiceIdentity)
  const error = await new PrivilegedBrokerClient(transport).healthCheck().catch((cause) => cause)
  return formatPrivilegedHealthDiagnostic(error)
}

describe('installed native service identity', () => {
  it('accepts a canonical 64-byte x64 QUERY_SERVICE_CONFIGW fixture with its path immediately after the header', async () => {
    nativeHarness.queryServiceConfigFixture = canonicalX64QueryServiceConfigFixture(`"${expectedWrapper}"`)

    expect(await diagnostic()).toBe('PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=request-write code=REQUEST_WRITE_FAILED\n')
    expect(nativeHarness.writeCalls).toBe(1)
  })

  it('accepts the exact pipe endpoint as the direct child of the configured running WinSW service when SYSTEM images are inaccessible', async () => {
    expect(await diagnostic()).toBe('PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=request-write code=REQUEST_WRITE_FAILED\n')
    expect(nativeHarness.writeCalls).toBe(1)
    expect(nativeHarness.closed).toEqual(expect.arrayContaining([10n, 11n, 12n, 1n]))
  })

  it('keeps non-default pipe identity strict when the server image is inaccessible', async () => {
    expect(await diagnostic('\\\\.\\pipe\\non-default-service-identity', false)).toBe(
      'PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=server-identity code=SERVER_IDENTITY_UNAVAILABLE\n',
    )
    expect(nativeHarness.writeCalls).toBe(0)
    expect(nativeHarness.closed).toEqual(expect.arrayContaining([1n]))
    expect(nativeHarness.closed).not.toEqual(expect.arrayContaining([10n]))
  })

  it.each([
    ['wrong configured binary path', () => { nativeHarness.configPath = 'C:\\Windows\\System32\\winsw.exe' }],
    ['quoted arguments', () => { nativeHarness.configPath = `"${expectedWrapper}" --service` }],
    ['wrong service name', () => { nativeHarness.serviceName = 'UnrelatedPrivilegedBroker' }],
    ['stopped service', () => { nativeHarness.statusState = 1 }],
    ['wrong direct parent', () => { nativeHarness.parentProcessId = 199 }],
    ['grandchild', () => { nativeHarness.parentProcessId = 250 }],
    ['zero service PID', () => { nativeHarness.statusPids = [0, 0] }],
    ['changed service PID', () => { nativeHarness.statusPids = [200, 200, 201, 201] }],
    ['changed pipe PID', () => { nativeHarness.getPipePids = [300, 301] }],
    ['accessible wrong server image', () => { nativeHarness.images.set(300, 'C:\\Users\\child\\malicious.exe') }],
    ['configuration query failure', () => { nativeHarness.configQueryFailure = true }],
    ['out-of-buffer configuration pointer', () => { nativeHarness.configPointerOutsideBuffer = true }],
  ])('rejects %s before writing', async (_reason, arrange) => {
    arrange()

    expect(await diagnostic()).toBe('PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=scm-lineage code=SCM_LINEAGE_MISMATCH\n')
    expect(nativeHarness.writeCalls).toBe(0)
    expect(nativeHarness.closed).toEqual(expect.arrayContaining([10n, 1n]))
  })
})
