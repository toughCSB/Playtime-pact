export const D1_FREE_LIMITS = Object.freeze({
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  storageBytes: 5_000_000_000,
  workerRequestsPerDay: 100_000,
  workerCpuMsPerRequest: 10,
})

export const DEFAULT_DAILY_WORKLOAD = Object.freeze({
  households: 1,
  parentDevices: 2,
  requestsPerHousehold: 12,
  pollsPerRequestPerDevice: 6,
  mutationsPerRequest: 8,
  cleanupWritesPerRequest: 2,
  fixedReadsPerHousehold: 48,
  fixedWritesPerHousehold: 8,
})

export function modelD1Usage(workload = DEFAULT_DAILY_WORKLOAD, multiplier = 1) {
  const households = Math.max(1, Math.trunc(workload.households * multiplier))
  const requests = households * workload.requestsPerHousehold
  const rowsRead = requests * workload.parentDevices * workload.pollsPerRequestPerDevice * 4
    + households * workload.fixedReadsPerHousehold
  const rowsWritten = requests * (workload.mutationsPerRequest + workload.cleanupWritesPerRequest)
    + households * workload.fixedWritesPerHousehold
  const storageBytes = households * 2_000_000
  const workerRequests = requests * (1 + workload.parentDevices * workload.pollsPerRequestPerDevice + workload.mutationsPerRequest + workload.cleanupWritesPerRequest)
    + households * 24
  const fcmMessages = requests * workload.parentDevices
  const maxCpuMsPerRequest = 4
  return { households, requests, rowsRead, rowsWritten, storageBytes, workerRequests, fcmMessages, maxCpuMsPerRequest }
}

export function assertHeadroom(usage, limits = D1_FREE_LIMITS) {
  const ratios = {
    rowsRead: usage.rowsRead / limits.rowsReadPerDay,
    rowsWritten: usage.rowsWritten / limits.rowsWrittenPerDay,
    storage: usage.storageBytes / limits.storageBytes,
    workerRequests: usage.workerRequests / limits.workerRequestsPerDay,
  }
  if (usage.maxCpuMsPerRequest >= limits.workerCpuMsPerRequest) throw new Error('Worker CPU estimate exceeds per-request limit')
  const peak = Math.max(...Object.values(ratios))
  if (peak >= 1) throw new Error(`Free-tier model exceeds capacity: ${JSON.stringify(ratios)}`)
  return { ratios, minimumHeadroomFactor: 1 / peak }
}

export function modelAbuseCeiling(households = 5) {
  return modelD1Usage({
    ...DEFAULT_DAILY_WORKLOAD,
    households,
    requestsPerHousehold: 96,
    pollsPerRequestPerDevice: 10,
    mutationsPerRequest: 6,
    cleanupWritesPerRequest: 2,
  })
}
