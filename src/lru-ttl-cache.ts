// LRU cache with TTL (e2e test fixture for Reckon).
export class LruTtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max: number, private ttlMs: number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) { this.map.delete(key); return undefined; }
    // Re-insert to move this key to the most-recently-used end of the Map's order.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      // Map preserves insertion order, so the first key is the least-recently-used.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
