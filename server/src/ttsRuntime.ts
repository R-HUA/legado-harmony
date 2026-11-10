export class TtsServerBusyError extends Error {
  constructor(message = '在线朗读请求较多，请稍后重试') {
    super(message);
  }
}

export type TtsReplayDecision =
  | 'IN_PROGRESS'
  | 'REFUNDED'
  | 'RETURN_CACHE'
  | 'RESULT_EXPIRED';

export function decideTtsReplay(status: string, cacheHit: boolean): TtsReplayDecision {
  if (status === 'RESERVED') return 'IN_PROGRESS';
  if (status !== 'SUCCEEDED') return 'REFUNDED';
  return cacheHit ? 'RETURN_CACHE' : 'RESULT_EXPIRED';
}

interface QueueItem {
  userId: string;
  member: boolean;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export class TtsConcurrencyLimiter {
  private active = 0;
  private readonly activeByUser = new Map<string, number>();
  private readonly queue: QueueItem[] = [];
  private memberStreak = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxConcurrentPerUser: number,
    private readonly queueLimit: number,
    private readonly queueTimeoutMs: number,
    private readonly now: () => number = Date.now
  ) {}

  acquire(userId: string, member = false): Promise<() => void> {
    this.dispatch();
    if (this.canStart(userId) && !this.queue.some(item => !item.settled && this.canStart(item.userId))) {
      return Promise.resolve(this.start(userId));
    }
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(new TtsServerBusyError());
    }
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        userId,
        member,
        enqueuedAt: this.now(),
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new TtsServerBusyError('在线朗读排队超时，请稍后重试'));
        }, this.queueTimeoutMs)
      };
      item.timer.unref?.();
      this.queue.push(item);
      this.dispatch();
    });
  }

  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length
    };
  }

  private canStart(userId: string): boolean {
    return this.active < this.maxConcurrent
      && (this.activeByUser.get(userId) || 0) < this.maxConcurrentPerUser;
  }

  private start(userId: string): () => void {
    this.active++;
    this.activeByUser.set(userId, (this.activeByUser.get(userId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const userActive = Math.max(0, (this.activeByUser.get(userId) || 1) - 1);
      if (userActive > 0) {
        this.activeByUser.set(userId, userActive);
      } else {
        this.activeByUser.delete(userId);
      }
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.maxConcurrent) {
      const eligible = (item: QueueItem) => !item.settled && this.canStart(item.userId);
      const normal = this.queue.findIndex(item => eligible(item) && !item.member);
      const member = this.queue.findIndex(item => eligible(item) && item.member);
      const oldest = this.queue.findIndex(eligible);
      // No new concurrency or preemption. Three member turns then one normal turn;
      // an aging request gets the next available slot regardless of its class.
      const aged = oldest >= 0 && this.now() - this.queue[oldest]!.enqueuedAt >= Math.min(3000, this.queueTimeoutMs / 2);
      const index = aged ? oldest : normal >= 0 && (this.memberStreak >= 3 || member < 0)
        ? normal : member >= 0 ? member : oldest;
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0]!;
      this.memberStreak = item.member ? Math.min(3, this.memberStreak + 1) : 0;
      item.settled = true;
      clearTimeout(item.timer);
      item.resolve(this.start(item.userId));
    }
  }
}

interface CacheEntry<T> {
  value: T;
  size: number;
  expiresAt: number;
}

export class ByteLimitedLruCache<T> {
  private readonly values = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntryBytes: number,
    private readonly ttlMs: number
  ) {}

  get(key: string, now = Date.now()): T | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.remove(key);
      return null;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, size: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxEntryBytes || size > this.maxBytes) {
      return false;
    }
    this.remove(key);
    this.pruneExpired(now);
    while (this.totalBytes + size > this.maxBytes && this.values.size > 0) {
      const oldestKey = this.values.keys().next().value;
      if (!oldestKey) break;
      this.remove(oldestKey);
    }
    if (this.totalBytes + size > this.maxBytes) return false;
    this.values.set(key, { value, size, expiresAt: now + this.ttlMs });
    this.totalBytes += size;
    return true;
  }

  snapshot() {
    return {
      entries: this.values.size,
      bytes: this.totalBytes
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.size);
  }
}
