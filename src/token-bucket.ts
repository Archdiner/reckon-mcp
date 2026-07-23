// Token-bucket rate limiter (e2e test fixture for Reckon).
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }
  // Lazily refill on read instead of a timer: no background interval to leak, and the
  // bucket stays accurate even if the process was idle for minutes.
  private refill(now: number): void {
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
  }
  tryRemove(cost = 1): boolean {
    const now = Date.now();
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
