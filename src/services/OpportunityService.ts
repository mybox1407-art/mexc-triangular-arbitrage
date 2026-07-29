import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type { Opportunity, Triangle } from '../domain/types.js';
import { ArbitrageCalculator } from './ArbitrageCalculator.js';
import { CsvBestRouteWriter } from './CsvBestRouteWriter.js';

type Diagnostics = {
  evaluated: number;
  unavailable: number;
  belowThreshold: number;
  opportunities: number;
  best: Opportunity | null;
};

export class OpportunityService {
  private readonly lastReported = new Map<string, number>();

  private readonly bestRouteWriter = new CsvBestRouteWriter(
    config.csvBestRoutesPath
  );

  private diagnostics: Diagnostics = {
    evaluated: 0,
    unavailable: 0,
    belowThreshold: 0,
    opportunities: 0,
    best: null
  };

  private lastDiagnosticsAt = Date.now();

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
      this.diagnostics.evaluated += 1;

      const opportunity = this.calculator.simulate(
        triangle,
        this.books,
        config.trading.startNotional
      );

      if (!opportunity) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      if (
        !this.diagnostics.best ||
        opportunity.netRoi > this.diagnostics.best.netRoi
      ) {
        this.diagnostics.best = opportunity;
      }

      if (opportunity.netRoi < config.trading.minNetRoi) {
        this.diagnostics.belowThreshold += 1;
        continue;
      }

      const lastAt = this.lastReported.get(opportunity.triangleId) ?? 0;

      if (Date.now() - lastAt < 1_000) {
        continue;
      }

      this.lastReported.set(opportunity.triangleId, Date.now());
      this.diagnostics.opportunities += 1;

      await this.onOpportunity(opportunity);
    }

    this.logDiagnosticsIfNeeded();
  }

  private logDiagnosticsIfNeeded(): void {
    const now = Date.now();

    if (now - this.lastDiagnosticsAt < 10_000) {
      return;
    }

    const {
      evaluated,
      unavailable,
      belowThreshold,
      opportunities,
      best
    } = this.diagnostics;

    console.info('Paper arbitrage diagnostics', {
      evaluated,
      unavailable,
      belowThreshold,
      opportunities,
      bestTriangle: best?.triangleId ?? null,
      bestStartAsset: best?.startAsset ?? null,
      bestStartAmount: best?.startAmount ?? config.trading.startNotional,
      bestFinalAmount: best?.finalAmount ?? null,
      bestGrossRoi: best?.grossRoi ?? null,
      bestNetRoi: best?.netRoi ?? null,
      bestExpectedProfit: best?.expectedProfit ?? null,
      minNetRoi: config.trading.minNetRoi,
      takerFeeRate: config.trading.takerFeeRate,
      safetyBufferRate: config.trading.safetyBufferRate
    });

    if (best) {
      void this.bestRouteWriter.write(best).catch((error) => {
        console.error('Failed to write best paper route CSV', error);
      });
    }

    this.diagnostics = {
      evaluated: 0,
      unavailable: 0,
      belowThreshold: 0,
      opportunities: 0,
      best: null
    };

    this.lastDiagnosticsAt = now;
  }
}
