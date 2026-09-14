import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const script = readFileSync(new URL('../scripts/allow-existing-game-runtimes.ps1', import.meta.url), 'utf8')

describe('standard-account game runtime policy helper', () => {
  it('limits discovery to Lunar and Minecraft Java runtimes', () => {
    expect(script).toContain("'.lunarclient\\jre'")
    expect(script).toContain("'AppData\\Roaming\\.minecraft\\runtime'")
    expect(script).toContain("@('java.exe', 'javaw.exe')")
  })

  it('uses update-tolerant publisher rules and exact hashes for unsigned files', () => {
    expect(script).toContain('$trustedPublisherSubjects')
    expect(script).toContain("$ruleType = if ($trustedPublisher) { 'Publisher' } else { 'Hash' }")
    expect(script).toContain("$range.HighSection = '*'")
    expect(script).toContain('Set-AppLockerPolicy -XmlPolicy $temporaryPolicy -Merge')
  })

  it('does not replace or disable the existing AppLocker policy', () => {
    expect(script).toContain("Get-AppLockerPolicy -Effective")
    expect(script).toContain("-Merge")
    expect(script).not.toMatch(/EnforcementMode=["']Disabled/)
    expect(script).not.toContain('Set-AppLockerPolicy -PolicyObject $null')
  })
})
