import { describe, expect, it } from 'vitest'
import {
  ADMIN_WINDOW_PROFILE,
  getCornerOverlayGeometry,
  getFullPageWindowGeometry,
  getWarningOverlayGeometry,
  MAIN_WINDOW_PROFILE,
} from '../src/main/windowGeometry.ts'

describe('full-page window geometry', () => {
  it('matches the approved logical-DIP examples', () => {
    expect(getFullPageWindowGeometry({ x: 0, y: 0, width: 1366, height: 728 }, MAIN_WINDOW_PROFILE))
      .toMatchObject({ width: 375, height: 680, x: 495, y: 24 })
    expect(getFullPageWindowGeometry({ x: 0, y: 0, width: 1366, height: 728 }, ADMIN_WINDOW_PROFILE))
      .toMatchObject({ width: 377, height: 680, x: 494, y: 24 })
    expect(getFullPageWindowGeometry({ x: 0, y: 0, width: 960, height: 500 }, MAIN_WINDOW_PROFILE))
      .toMatchObject({ width: 249, height: 452, x: 355, y: 24 })
    expect(getFullPageWindowGeometry({ x: 0, y: 0, width: 960, height: 500 }, ADMIN_WINDOW_PROFILE))
      .toMatchObject({ width: 251, height: 452, x: 354, y: 24 })
  })

  it('centers within negative-origin and tiny work areas without exceeding them', () => {
    const negative = getFullPageWindowGeometry({ x: -1280, y: -200, width: 1280, height: 720 }, MAIN_WINDOW_PROFILE)
    expect(negative.x).toBeGreaterThanOrEqual(-1280)
    expect(negative.y).toBeGreaterThanOrEqual(-200)
    expect(negative.x + negative.width).toBeLessThanOrEqual(0)
    expect(negative.y + negative.height).toBeLessThanOrEqual(520)

    const tiny = getFullPageWindowGeometry({ x: 10, y: 20, width: 180, height: 240 }, MAIN_WINDOW_PROFILE)
    expect(tiny.profile).toBe('compact-emergency')
    expect(tiny.width).toBeLessThanOrEqual(180)
    expect(tiny.height).toBeLessThanOrEqual(240)
  })

  it('never upscales preferred profiles', () => {
    const main = getFullPageWindowGeometry({ x: 0, y: 0, width: 3840, height: 2160 }, MAIN_WINDOW_PROFILE)
    const admin = getFullPageWindowGeometry({ x: 0, y: 0, width: 3840, height: 2160 }, ADMIN_WINDOW_PROFILE)
    expect(main).toMatchObject({ width: 420, height: 760, profile: 'preferred' })
    expect(admin).toMatchObject({ width: 400, height: 720, profile: 'preferred' })
  })
})

describe('compact overlay geometry', () => {
  it.each([
    {
      label: '1080p',
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      corner: { width: 200, height: 84, x: 1696, y: 26 },
      warning: { width: 320, height: 140, x: 800, y: 294 },
    },
    {
      label: '4K',
      workArea: { x: 0, y: 0, width: 3840, height: 2080 },
      corner: { width: 360, height: 151, x: 3448, y: 32 },
      warning: { width: 480, height: 200, x: 1680, y: 628 },
    },
  ])('places overlays correctly on $label landscape displays', ({ workArea, corner, warning }) => {
    const actualCorner = getCornerOverlayGeometry(workArea)
    const actualWarning = getWarningOverlayGeometry(workArea)

    expect(actualCorner).toEqual(corner)
    expect(actualWarning).toEqual(warning)
    expect(actualCorner.x + actualCorner.width).toBeLessThan(workArea.x + workArea.width)
    expect(actualCorner.y).toBeGreaterThan(workArea.y)
    expect(actualWarning.x + actualWarning.width / 2).toBe(workArea.x + workArea.width / 2)
    expect(actualWarning.y + actualWarning.height / 2).toBeLessThan(workArea.y + workArea.height / 2)
  })

  it('anchors the default timer to relative top-right work-area insets', () => {
    expect(getCornerOverlayGeometry({ x: 0, y: 0, width: 1920, height: 1040 }))
      .toEqual({ width: 200, height: 84, x: 1696, y: 26 })
    expect(getCornerOverlayGeometry({ x: -1366, y: 40, width: 1366, height: 728 }))
      .toEqual({ width: 200, height: 84, x: -217, y: 58 })
  })

  it('centers warnings horizontally above the vertical midpoint', () => {
    const workArea = { x: -1920, y: 20, width: 1920, height: 1040 }
    const warning = getWarningOverlayGeometry(workArea)

    expect(warning).toEqual({ width: 320, height: 140, x: -1120, y: 314 })
    expect(warning.y + warning.height / 2).toBeLessThan(workArea.y + workArea.height / 2)
  })
})
