// Rate limit of what a sender may report to the fault registry. Two token buckets per sender: a short one for bursts
// (PER_SECOND) and a long one for sustained noise (PER_MINUTE). A report needs a token from both; a refused one is
// dropped by the caller and counted (`noteDropped`), so a page stuck in an error loop cannot fill the disk or the main
// process' time.

export const REPORTS_PER_SECOND = 20
export const REPORTS_PER_MINUTE = 200
const MAX_SENDERS = 256

interface Bucket { tokens: number; at: number }

export class FaultRateLimiter {
  private readonly senders = new Map<string, { second: Bucket; minute: Bucket }>()
  private readonly now: () => number
  private readonly perSecond: number
  private readonly perMinute: number
  constructor(now: () => number = Date.now, perSecond = REPORTS_PER_SECOND, perMinute = REPORTS_PER_MINUTE) {
    this.now = now
    this.perSecond = perSecond
    this.perMinute = perMinute
  }

  private static take(b: Bucket, capacity: number, perMs: number, t: number): boolean {
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * perMs)
    b.at = t
    return b.tokens >= 1
  }

  /** True (and a token spent in both buckets) when `sender` may report now. */
  allow(sender: string): boolean {
    const t = this.now()
    let s = this.senders.get(sender)
    if (!s) {
      if (this.senders.size >= MAX_SENDERS) this.senders.delete(this.senders.keys().next().value!)
      s = { second: { tokens: this.perSecond, at: t }, minute: { tokens: this.perMinute, at: t } }
      this.senders.set(sender, s)
    }
    const okSecond = FaultRateLimiter.take(s.second, this.perSecond, this.perSecond / 1000, t)
    const okMinute = FaultRateLimiter.take(s.minute, this.perMinute, this.perMinute / 60_000, t)
    if (!okSecond || !okMinute) return false
    s.second.tokens--
    s.minute.tokens--
    return true
  }
}
