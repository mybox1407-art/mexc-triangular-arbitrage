import type { BookLevel, OrderBookSnapshot } from './types.js';

export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  private lastUpdateId = 0;
  private isReady = false;
  private updatedAt = 0;

  constructor(public readonly symbol: string) {}

  loadSnapshot(snapshot: {
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  }): void {
    this.bids.clear();
    this.asks.clear();

    for (const [price, quantity] of snapshot.bids) {
      this.setLevel(this.bids, Number(price), Number(quantity));
    }

    for (const [price, quantity] of snapshot.asks) {
      this.setLevel(this.asks, Number(price), Number(quantity));
    }

    this.lastUpdateId = snapshot.lastUpdateId;
    this.isReady = true;
    this.updatedAt = Date.now();
  }

  applyDelta(delta: {
    fromVersion: number;
    toVersion: number;
    bids: [string, string][];
    asks: [string, string][];
  }): boolean {
    if (!this.isReady) return false;

    if (delta.toVersion <= this.lastUpdateId) {
      return true;
    }

    if (delta.fromVersion !== this.lastUpdateId + 1) {
      this.isReady = false;
      return false;
    }

    for (const [price, quantity] of delta.bids) {
      this.setLevel(this.bids, Number(price), Number(quantity));
    }

    for (const [price, quantity] of delta.asks) {
      this.setLevel(this.asks, Number(price), Number(quantity));
    }

    this.lastUpdateId = delta.toVersion;
    this.updatedAt = Date.now();
    return true;
  }

  getSnapshot(depth = 50): OrderBookSnapshot {
    return {
      symbol: this.symbol,
      lastUpdateId: this.lastUpdateId,
      bids: this.sortedLevels(this.bids, 'DESC', depth),
      asks: this.sortedLevels(this.asks, 'ASC', depth),
      updatedAt: this.updatedAt,
      ready: this.isReady
    };
  }

  private setLevel(levels: Map<number, number>, price: number, quantity: number): void {
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return;

    if (quantity <= 0) {
      levels.delete(price);
      return;
    }

    levels.set(price, quantity);
  }

  private sortedLevels(
    levels: Map<number, number>,
    direction: 'ASC' | 'DESC',
    depth: number
  ): BookLevel[] {
    return [...levels.entries()]
      .sort(([a], [b]) => direction === 'ASC' ? a - b : b - a)
      .slice(0, depth)
      .map(([price, quantity]) => ({ price, quantity }));
  }
}
