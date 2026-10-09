/**
 * Multi-rate timing (Section 4.1).
 *
 * Time advances in integer physics ticks of DT_PHYS (1 ms) so that rates never drift:
 * a task running at f Hz fires on ticks that are multiples of round(1 / (f * dt)).
 * Latencies are implemented with timestamped FIFO queues (never by shifting arrays): an item
 * pushed at time t with delay tau is delivered at the first tick with time >= t + tau.
 */

/** Number of physics ticks per period of a task running at `hz`. */
export function periodTicks(hz: number, dt: number): number {
  return Math.max(1, Math.round(1 / (hz * dt)));
}

export class RateTask {
  readonly period: number;
  constructor(hz: number, dt: number, private readonly offset = 0) {
    this.period = periodTicks(hz, dt);
  }
  fires(tick: number): boolean {
    return tick >= this.offset && (tick - this.offset) % this.period === 0;
  }
}

interface QueueItem<T> {
  tSend: number;
  tDeliver: number;
  item: T;
}

/** Timestamped FIFO delay line. Items are delivered in order of their delivery time. */
export class DelayQueue<T> {
  private items: QueueItem<T>[] = [];
  private head = 0;

  push(tSend: number, delay: number, item: T): void {
    const tDeliver = tSend + Math.max(0, delay);
    // delays are constant per queue in practice; keep order robust anyway
    let k = this.items.length;
    while (k > this.head && this.items[k - 1].tDeliver > tDeliver) k--;
    this.items.splice(k, 0, { tSend, tDeliver, item });
  }

  /** Pop every item whose delivery time is <= t (with a small tolerance for float rounding). */
  popReady(t: number): T[] {
    const out: T[] = [];
    while (this.head < this.items.length && this.items[this.head].tDeliver <= t + 1e-9) {
      out.push(this.items[this.head].item);
      this.head++;
    }
    if (this.head > 256 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  /** Latest ready item, discarding older ones (null if none ready). */
  popLatest(t: number): T | null {
    const ready = this.popReady(t);
    return ready.length ? ready[ready.length - 1] : null;
  }

  /** Items still in flight (sent, not yet delivered), oldest first. */
  inFlight(): readonly { tSend: number; tDeliver: number; item: T }[] {
    return this.items.slice(this.head);
  }

  get size(): number {
    return this.items.length - this.head;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}
