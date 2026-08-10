import type { ManagedGameId } from './types'

export interface ManagedProcessRecord {
  processId?: number | string | null
  processStartedAt?: number | string | null
  name?: string | null
  executablePath?: string | null
  commandLine?: string | null
}

export interface ManagedLaunchCommand {
  gameId: ManagedGameId
  executablePath: string
  args: string[]
}

export interface ClassifiedManagedGameProcess {
  gameId: ManagedGameId
  pid: number
  processStartedAt?: number
  imageName: string
}

export interface ManagedGameSnapshot {
  activeGameIds: ManagedGameId[]
  classifiedProcesses: ClassifiedManagedGameProcess[]
  launchCommands: ManagedLaunchCommand[]
}

const MANAGED_GAME_IMAGE_HINTS: Record<ManagedGameId, readonly string[]> = {
  minecraft: [
    'minecraft.exe',
    'minecraft.windows.exe',
    'minecraftlauncher.exe',
    'lunar client.exe',
    'lunar client (qt5).exe',
    'badlion client.exe',
    'badlionclient.exe',
    'feather client.exe',
    'prismlauncher.exe',
    'multimc.exe',
    'polymc.exe',
    'hmcl.exe',
    'pcl2.exe',
    'java.exe',
    'javaw.exe',
  ],
  roblox: [
    'robloxplayer.exe',
    'robloxplayerbeta.exe',
  ],
}

const MINECRAFT_COMMAND_HINTS = [
  '.minecraft',
  'minecraft',
  'lunarclient',
  'badlion',
  'feather',
  'prismlauncher',
  'multimc',
  'polymc',
  'hmcl',
  'pcl2',
  'fabric-loader',
  'forge',
] as const

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function splitWindowsCommandLine(commandLine: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (/\s/.test(ch) && !inQuotes) {
      if (current) {
        result.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current) result.push(current)
  return result
}

export function getManagedGameDisplayName(gameId: ManagedGameId): string {
  return gameId === 'minecraft' ? 'Minecraft' : 'Roblox'
}

export function getManagedGameProcessImageNames(): string[] {
  return Array.from(new Set(Object.values(MANAGED_GAME_IMAGE_HINTS).flat()))
}

export function normalizeManagedGameIds(gameIds: readonly ManagedGameId[] | null | undefined): ManagedGameId[] {
  const normalized: ManagedGameId[] = []
  for (const gameId of gameIds ?? []) {
    const candidate = gameId === 'minecraft' ? 'minecraft' : gameId === 'roblox' ? 'roblox' : null
    if (candidate && !normalized.includes(candidate)) normalized.push(candidate)
  }
  return normalized
}

export function classifyManagedGameProcess(record: ManagedProcessRecord): ManagedGameId | null {
  const name = normalizeText(record.name)
  const executablePath = normalizeText(record.executablePath)
  const commandLine = normalizeText(record.commandLine)
  const searchable = `${name}\n${executablePath}\n${commandLine}`

  if (MANAGED_GAME_IMAGE_HINTS.roblox.includes(name)) return 'roblox'
  if (name !== 'java.exe' && name !== 'javaw.exe' && MANAGED_GAME_IMAGE_HINTS.minecraft.includes(name)) {
    return 'minecraft'
  }

  if ((name === 'java.exe' || name === 'javaw.exe') && MINECRAFT_COMMAND_HINTS.some((hint) => searchable.includes(hint))) {
    return 'minecraft'
  }

  if (name && name !== 'java.exe' && name !== 'javaw.exe' && MINECRAFT_COMMAND_HINTS.some((hint) => searchable.includes(hint))) {
    return 'minecraft'
  }

  return null
}

function toLaunchCommand(record: ManagedProcessRecord, gameId: ManagedGameId): ManagedLaunchCommand | null {
  const executablePath = typeof record.executablePath === 'string' ? record.executablePath.trim() : ''
  const imageName = normalizeText(record.name)
  if (imageName === 'java.exe' || imageName === 'javaw.exe') return null
  if (!executablePath) return null

  const parts = typeof record.commandLine === 'string' ? splitWindowsCommandLine(record.commandLine) : []
  const args = parts.length > 0 ? parts.slice(1) : []
  return { gameId, executablePath, args }
}

export function collectManagedGameSnapshot(records: readonly ManagedProcessRecord[]): ManagedGameSnapshot {
  const activeGameIds: ManagedGameId[] = []
  const classifiedProcesses: ClassifiedManagedGameProcess[] = []
  const launchCommands: ManagedLaunchCommand[] = []
  const launchCommandKeys = new Set<string>()
  const classifiedPids = new Set<number>()

  for (const record of records) {
    const gameId = classifyManagedGameProcess(record)
    if (!gameId) continue

    if (!activeGameIds.includes(gameId)) activeGameIds.push(gameId)

    const pid = Number(record.processId)
    const processStartedAt = Number(record.processStartedAt)
    const imageName = typeof record.name === 'string' ? record.name.trim() : ''
    if (Number.isInteger(pid) && pid > 0 && imageName && !classifiedPids.has(pid)) {
      classifiedPids.add(pid)
      classifiedProcesses.push({
        gameId,
        pid,
        imageName,
        processStartedAt: Number.isFinite(processStartedAt) && processStartedAt > 0 ? processStartedAt : undefined,
      })
    }

    const launchCommand = toLaunchCommand(record, gameId)
    if (!launchCommand) continue

    const key = `${launchCommand.gameId}\u0000${launchCommand.executablePath}\u0000${launchCommand.args.join('\u0000')}`
    if (launchCommandKeys.has(key)) continue
    launchCommandKeys.add(key)
    launchCommands.push(launchCommand)
  }

  return { activeGameIds, classifiedProcesses, launchCommands }
}

export function selectPrimaryManagedGame(
  activeGameIds: readonly ManagedGameId[],
  lastDetectedAt: Partial<Record<ManagedGameId, number>>,
  previousPrimaryGameId?: ManagedGameId | null,
): ManagedGameId | undefined {
  const active = normalizeManagedGameIds(activeGameIds)
  if (active.length === 0) return undefined

  let selected = active[0]
  let selectedScore = Number(lastDetectedAt[selected] ?? 0)

  for (const gameId of active.slice(1)) {
    const score = Number(lastDetectedAt[gameId] ?? 0)
    if (score > selectedScore) {
      selected = gameId
      selectedScore = score
      continue
    }
    if (score === selectedScore && previousPrimaryGameId === gameId) {
      selected = gameId
      selectedScore = score
    }
  }

  if (previousPrimaryGameId && active.includes(previousPrimaryGameId)) {
    const previousScore = Number(lastDetectedAt[previousPrimaryGameId] ?? 0)
    if (previousScore === selectedScore) return previousPrimaryGameId
  }

  return selected
}

export function listSecondaryManagedGames(
  primaryGameId: ManagedGameId | null | undefined,
  activeGameIds: readonly ManagedGameId[],
): ManagedGameId[] {
  return normalizeManagedGameIds(activeGameIds).filter((gameId) => gameId !== primaryGameId)
}
