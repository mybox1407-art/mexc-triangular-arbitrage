import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type { Opportunity, Triangle } from '../domain/types.js';
import { ArbitrageCalculator } from './ArbitrageCalculator.js';

export class OpportunityService {
  private readonly lastReported = new Map<string, number>();

  constructor(
    private readonly triangles: Triangle[],
    private readonly books: Map<string, OrderBook>,
    private readonly calculator: ArbitrageCalculator,
    private readonly onOpportunity: (opportunity: Opportunity) => Promise<void>
  ) {}

  async evaluateAffected(symbol: string): Promise<void> {
    const relevant = this.triangles.filter((triangle) =>
      triangle.legs.some((leg) => leg.symbol === symbol)
    );

    for (const triangle of relevant) {
      const opportunity = this.calculator.simulate(
        triangle,
        this.books,
        config.trading.startNotional
      );

      if (!opportunity) continue;
      if (opportunity.netRoi < config.trading.minNetRoi) continue;

      const lastAt = this.lastReported.get(opportunity.triangleId) ?? 0;
      if (Date.now() - lastAt < 1_000) continue;

      this.lastReported.set(opportunity.triangleId, Date.now());
      await this.onOpportunity(opportunity);
    }
  }
}
