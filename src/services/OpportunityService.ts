import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type { Opportunity, Triangle } from '../domain/types.js';
import { ArbitrageCalculator } from './ArbitrageCalculator.js';
import { CsvBestRouteWriter } from './CsvBestRouteWriter.js';
import { PerformanceLogWriter } from './PerformanceLogWriter.js';  // ← ДОБАВИТЬ

type Diagnostics = {
  evaluated: number;
  unavailable: number;
  belowThreshold: number;
  opportunities: number;
  best: Opportunity | null;
};

const STALE_BOOK_AFTER_MS = 5_000;

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
    private readonly performanceLogWriter: PerformanceLogWriter,  // ← ДОБАВИТЬ
    private readonly onOpportunity: (opportunity: Opportunity) => Promise<void>
  ) {}

  async evaluateAffected(symbol: string): Promise<void> {
    const relevant = this.triangles.filter((triangle) =>
      triangle.legs.some((leg) => leg.symbol === symbol)
    );

    for (const triangle of relevant) {
      this.diagnostics.evaluated += 1;

      const evaluationStart = Date.now();  // ← ДОБАВИТЬ

      const opportunity = this.calculator.simulate(
        triangle,
        this.books,
        config.trading.startNotional
      );

      if (!opportunity) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      // === ДОБАВИТЬ: Возраст стаканов ===
      const bookAges = triangle.legs.map(leg => {
        const book = this.books.get(leg.symbol);
        const snapshot = book.getSnapshot(5);
        return {
          symbol: leg.symbol,
          ageMs: Date.now() - snapshot.updatedAt
        };
      });
      const maxBookAge = Math.max(...bookAges.map(b => b.ageMs));

      // === ДОБАВИТЬ: Проверка на stale ===
      if (maxBookAge > STALE_BOOK_AFTER_MS) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      if (
        !this.diagnostics.best ||
        opportunity.netRoi > this.diagnostics.best.netRoi
      ) {
        this.diagnostics.best = opportunity;
      }

      // Фильтр теперь по gross ROI после комиссий (до safety buffer).
      if (
        opportunity.grossRoiAfterFees <
        config.trading.minGrossRoiAfterFees
      ) {
        this.diagnostics.belowThreshold += 1;
        continue;
      }

      const lastAt =
        this.lastReported.get(opportunity.triangleId) ?? 0;

      if (Date.now() - lastAt < 1_000) {
        continue;
      }

      this.lastReported.set(opportunity.triangleId, Date.now());
      this.diagnostics.opportunities += 1;

      // === ДОБАВИТЬ: Логирование в performance файл ===
      const evaluationTime = Date.now() - evaluationStart;
      await this.performanceLogWriter.write(
        opportunity,
        evaluationTime,
        bookAges
      );

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

    // === ДОБАВЛЕНО: Диагностика возраста стаканов ===
    const bookAges = [...this.books.values()].map(book => {
      const snapshot = book.getSnapshot(5);
      return {
        symbol: snapshot.symbol,
        ageMs: now - snapshot.updatedAt
      };
    });

    const staleBooks = bookAges.filter(b => b.ageMs > STALE_BOOK_AFTER_MS);

    console.info('Paper arbitrage diagnostics', {
      evaluated,
      unavailable,
      belowThreshold,
      opportunities,
      bestTriangle: best?.triangleId ?? null,
      bestStartAsset: best?.startAsset ?? null,
      bestStartAmount:
        best?.startAmount ?? config.trading.startNotional,
      bestFinalAmount: best?.finalAmount ?? null,
      bestGrossRoiBeforeFees: best?.grossRoiBeforeFees ?? null,
      bestGrossRoiAfterFees: best?.grossRoiAfterFees ?? null,
      bestTotalFeeRate: best?.totalFeeRate ?? null,
      bestTotalFeeInStartAsset: best?.totalFeeInStartAsset ?? null,
      bestNetRoi: best?.netRoi ?? null,
      bestExpectedProfit: best?.expectedProfit ?? null,
      minGrossRoiAfterFees: config.trading.minGrossRoiAfterFees,
      minNetRoi: config.trading.minNetRoi,
      takerFeeRate: config.trading.takerFeeRate,
      safetyBufferRate: config.trading.safetyBufferRate,
      bookAges,              // ← ДОБАВЛЕНО
      staleBooksCount: staleBooks.length  // ← ДОБАВЛЕНО
    });

    if (best) {
      void this.bestRouteWriter.write(best).catch((error) => {
        console.error(
          'Failed to write best paper route CSV',
          error
        );
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
