export type WindowProfileKind = 'preferred' | 'scaled' | 'compact' | 'compact-emergency'

export interface WorkAreaRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowProfile {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface WindowGeometry {
  width: number
  height: number
  x: number
  y: number
  profile: WindowProfileKind
}
export interface OverlayGeometry {
  width: number
  height: number
  x: number
  y: number
}

export const MAIN_WINDOW_PROFILE: WindowProfile = {
  width: 420,
  height: 760,
  minWidth: 240,
  minHeight: 434,
}

export const ADMIN_WINDOW_PROFILE: WindowProfile = {
  width: 400,
  height: 720,
  minWidth: 240,
  minHeight: 432,
}

const WORK_AREA_INSET = 24
const CORNER_HORIZONTAL_INSET_RATIO = 0.0125
const CORNER_VERTICAL_INSET_RATIO = 0.025
const WARNING_CENTER_Y_RATIO = 0.35

function boundedInset(size: number, ratio: number): number {
  return Math.max(12, Math.min(32, Math.round(size * ratio)))
}

export function getCornerOverlayGeometry(workArea: WorkAreaRect): OverlayGeometry {
  const scale = workArea.width / 1920
  const width = Math.round(Math.min(360, Math.max(200, 200 * scale)))
  const height = Math.round(width * 0.42)
  const rightInset = boundedInset(workArea.width, CORNER_HORIZONTAL_INSET_RATIO)
  const topInset = boundedInset(workArea.height, CORNER_VERTICAL_INSET_RATIO)

  return {
    width,
    height,
    x: workArea.x + workArea.width - width - rightInset,
    y: workArea.y + topInset,
  }
}

export function getWarningOverlayGeometry(workArea: WorkAreaRect): OverlayGeometry {
  const scale = workArea.width / 1920
  const width = Math.round(Math.min(480, Math.max(320, 320 * scale)))
  const height = Math.round(Math.min(200, Math.max(140, 140 * scale)))

  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round(workArea.height * WARNING_CENTER_Y_RATIO - height / 2),
  }
}

export function getFullPageWindowGeometry(workArea: WorkAreaRect, profile: WindowProfile): WindowGeometry {
  const availableWidth = Math.max(1, workArea.width - WORK_AREA_INSET * 2)
  const availableHeight = Math.max(1, workArea.height - WORK_AREA_INSET * 2)
  const scale = Math.min(1, availableWidth / profile.width, availableHeight / profile.height)
  const width = Math.max(1, Math.min(workArea.width, Math.floor(profile.width * scale + 1e-9)))
  const height = Math.max(1, Math.min(workArea.height, Math.floor(profile.height * scale + 1e-9)))

  let profileKind: WindowProfileKind = 'preferred'
  if (scale < 1) profileKind = width >= 320 && height >= 576 ? 'scaled' : 'compact'
  if (width < profile.minWidth || height < profile.minHeight) profileKind = 'compact-emergency'

  return {
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    profile: profileKind,
  }
}
