/** One parent approval authorizes only the first fresh game launch, for five minutes. */
export class LocalStartApproval {
  private approval: { issuedAt: number; monotonicIssuedAt: number; policyVersion: number } | null = null
  constructor(
    private readonly now = () => Date.now(),
    private readonly monotonicNow = () => performance.now(),
  ) {}
  issue(policyVersion: number): void {
    this.approval = { issuedAt: this.now(), monotonicIssuedAt: this.monotonicNow(), policyVersion }
  }
  claim(processStartedAt: number, policyVersion: number): boolean {
    const approval = this.approval
    if (!approval) return false
    const now = this.now()
    const elapsed = this.monotonicNow() - approval.monotonicIssuedAt
    if (elapsed < 0 || elapsed >= 300_000 || now < approval.issuedAt
      || now - approval.issuedAt >= 300_000 || policyVersion !== approval.policyVersion) {
      this.approval = null
      return false
    }
    if (!Number.isFinite(processStartedAt) || processStartedAt <= approval.issuedAt || processStartedAt > now) return false
    this.approval = null
    return true
  }
}
