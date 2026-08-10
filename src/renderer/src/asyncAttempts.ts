import type { AdminApprovalResult, TimerStartResult } from '../../shared/types'

type SettingsUnlockBridge = ((pin: string) => Promise<boolean>) | undefined
type ParentApprovalBridge = ((pin: string) => Promise<AdminApprovalResult>) | undefined

type PinAttemptResult<T> = {
  value: T | null
  pin: ''
  error: string
}

export async function attemptSettingsUnlock(
  pin: string,
  unlock: SettingsUnlockBridge,
): Promise<PinAttemptResult<boolean>> {
  if (!unlock) {
    return { value: null, pin: '', error: '앱 연결을 확인할 수 없어요. 앱을 다시 시작해주세요.' }
  }
  try {
    const value = await unlock(pin)
    return { value, pin: '', error: value ? '' : 'PIN이 틀렸어요.' }
  } catch {
    return { value: null, pin: '', error: '인증 서비스에 연결할 수 없어요. 다시 시도해주세요.' }
  }
}

export async function attemptParentApproval(
  pin: string,
  approve: ParentApprovalBridge,
): Promise<PinAttemptResult<AdminApprovalResult>> {
  if (!approve) {
    return { value: null, pin: '', error: '승인 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.' }
  }
  try {
    const value = await approve(pin)
    return { value, pin: '', error: value.ok ? '' : 'PIN이 올바르지 않아요.' }
  } catch {
    return { value: null, pin: '', error: '승인 서비스에 연결할 수 없어요. 잠시 후 다시 시도해주세요. 문제가 계속되면 Playtime Pact를 다시 시작해주세요.' }
  }
}

export async function attemptTimerStart(
  limitMinutes: number,
  start: (limitMinutes: number) => Promise<TimerStartResult>,
): Promise<{ value: TimerStartResult | null; error: string }> {
  try {
    return { value: await start(limitMinutes), error: '' }
  } catch {
    return { value: null, error: '타이머를 시작하지 못했어요. 다시 시도해주세요.' }
  }
}
