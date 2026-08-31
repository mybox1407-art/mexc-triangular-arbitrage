// src/services/OpportunityService.ts

import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type {
  BookLevel,
  Opportunity,
  Triangle
} from '../domain/types.js';
import { ArbitrageCalculator } from './ArbitrageCalculator.js';
import { CsvBestRouteWriter } from './CsvBestRouteWriter.js';
import { PerformanceLogWriter } from './PerformanceLogWriter.js';

type Diagnostics = {
  evaluated: number;
  unavailable: number;
  belowThreshold: number;
  opportunities: number;
  best: Opportunity | null;
};

type BookAge = {
  symbol: string;
  ageMs: number;
};

type FixedBookSnapshot = {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ready: boolean;
  updatedAt: number;
};

const STALE_BOOK_AFTER_MS = 5_000;
const MAX_EXECUTION_BOOK_AGE_MS = 500;
const REPORT_THROTTLE_MS = 1_000;

export class OpportunityService {
  private readonly lastReported =
    new Map<string, number>();

  private readonly inFlightTriangles =
    new Set<string>();

  private diagnostics: Diagnostics = {
    evaluated: 0,
    unavailable: 0,
    belowThreshold: 0,
    opportunities: 0,
    best: null
  };

  private lastDiagnosticsAt =
    Date.now();

  constructor(
    private readonly triangles: Triangle[],
    private readonly books: Map<string, OrderBook>,
    private readonly calculator: ArbitrageCalculator,
    private readonly performanceLogWriter: PerformanceLogWriter,

    // Новый callback: вызывается для ВСЕХ положительных возможностей (expectedProfit > 0)
    private readonly onPositiveOpportunity: (
      opportunity: Opportunity,
      triangle: Triangle
    ) => Promise<void>,

    // Старый callback: вызывается только для возможностей, прошедших порог
    private readonly onOpportunity: (
      opportunity: Opportunity
    ) => Promise<void>,

    private readonly bestRouteWriter?: CsvBestRouteWriter
  ) {}

  async evaluateAffected(
    symbol: string
  ): Promise<void> {
    const relevant =
      this.triangles.filter(
        (triangle) =>
          triangle.legs.some(
            (leg) =>
              leg.symbol === symbol
          )
      );

    for (const triangle of relevant) {
      this.diagnostics.evaluated += 1;

      const evaluationStartedAt =
        Date.now();

      const snapshotState =
        this.collectSnapshotState(
          triangle,
          evaluationStartedAt
        );

      if (!snapshotState) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      const {
        snapshots,
        bookAges,
        maxBookAge
      } = snapshotState;

      if (
        maxBookAge >
        STALE_BOOK_AFTER_MS
      ) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      const hasTooOldBook =
        bookAges.some(
          (book) =>
            book.ageMs >
            MAX_EXECUTION_BOOK_AGE_MS
        );

      if (hasTooOldBook) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      const opportunity =
        this.calculator.simulateFromSnapshots(
          triangle,
          snapshots,
          config.trading.startNotional
        );

      if (!opportunity) {
        this.diagnostics.unavailable += 1;
        continue;
      }

      if (
        !this.diagnostics.best ||
        opportunity.netRoi >
          this.diagnostics.best.netRoi
      ) {
        this.diagnostics.best =
          opportunity;
      }

      // === НОВОЕ: пишем ВСЕ положительные возможности (expectedProfit > 0) ===
      if (opportunity.expectedProfit > 0) {
        void this.onPositiveOpportunity(
          opportunity,
          triangle
        ).catch((error) => {
          console.error(
            'Failed to write positive opportunity',
            error
          );
        });
      }

      // === СТАРАЯ ЛОГИКА: фильтр по порогу для исполнения и Telegram ===
      if (
        !this.passesThreshold(
          opportunity
        )
      ) {
        this.diagnostics.belowThreshold += 1;
        continue;
      }

      const decisionNow =
        Date.now();

      const lastAt =
        this.lastReported.get(
          opportunity.triangleId
        ) ?? 0;

      if (
        decisionNow - lastAt <
        REPORT_THROTTLE_MS
      ) {
        continue;
      }

      if (
        this.inFlightTriangles.has(
          opportunity.triangleId
        )
      ) {
        continue;
      }

      this.lastReported.set(
        opportunity.triangleId,
        decisionNow
      );

      this.inFlightTriangles.add(
        opportunity.triangleId
      );

      this.diagnostics.opportunities += 1;

      const evaluationTime =
        decisionNow -
        evaluationStartedAt;

      void this.performanceLogWriter
        .write(
          opportunity,
          evaluationTime,
          bookAges
        )
        .catch((error) => {
          console.error(
            'Failed to write performance log',
            error
          );
        });

      try {
        await this.onOpportunity(
          opportunity
        );
      } finally {
        this.inFlightTriangles.delete(
          opportunity.triangleId
        );
      }
    }

    this.logDiagnosticsIfNeeded();
  }

  private passesThreshold(
    opportunity: Opportunity
  ): boolean {
    return (
      opportunity.grossRoiAfterFees >=
      config.trading.minGrossRoiAfterFees
    );
  }

  private collectSnapshotState(
    triangle: Triangle,
    now: number
  ): {
    snapshots: Map<
      string,
      FixedBookSnapshot
    >;
    bookAges: BookAge[];
    maxBookAge: number;
  } | null {
    const snapshots =
      new Map<
        string,
        FixedBookSnapshot
      >();

    const bookAges: BookAge[] = [];

    for (const leg of triangle.legs) {
      const book =
        this.books.get(leg.symbol);

      if (!book) {
        return null;
      }

      const snapshot =
        book.getSnapshot(100);

      if (!snapshot.ready) {
        return null;
      }

      snapshots.set(
        leg.symbol,
        {
          symbol: snapshot.symbol,
          bids: snapshot.bids,
          asks: snapshot.asks,
          ready: snapshot.ready,
          updatedAt: snapshot.updatedAt
        }
      );

      bookAges.push({
        symbol: snapshot.symbol,
        ageMs:
          now - snapshot.updatedAt
      });
    }

    const maxBookAge =
      bookAges.length > 0
        ? Math.max(
            ...bookAges.map(
              (book) =>
                book.ageMs
            )
          )
        : 0;

    return {
      snapshots,
      bookAges,
      maxBookAge
    };
  }

  private logDiagnosticsIfNeeded(): void {
    const now =
      Date.now();

    if (
      now - this.lastDiagnosticsAt <
      10_000
    ) {
      return;
    }

    const {
      evaluated,
      unavailable,
      belowThreshold,
      opportunities,
      best
    } = this.diagnostics;

    const bookAges =
      [...this.books.values()]
        .map((book) => {
          const snapshot =
            book.getSnapshot(5);

          return {
            symbol: snapshot.symbol,
            ageMs:
              now - snapshot.updatedAt
          };
        });

    const staleBooks =
      bookAges.filter(
        (book) =>
          book.ageMs >
          STALE_BOOK_AFTER_MS
      );

    console.info(
      'Arbitrage diagnostics',
      {
        evaluated,
        unavailable,
        belowThreshold,
        opportunities,
        bestTriangle:
          best?.triangleId ?? null,
        bestStartAsset:
          best?.startAsset ?? null,
        bestStartAmount:
          best?.startAmount ??
          config.trading.startNotional,
        bestFinalAmount:
          best?.finalAmount ?? null,
        bestGrossRoiBeforeFees:
          best?.grossRoiBeforeFees ??
          null,
        bestGrossRoiAfterFees:
          best?.grossRoiAfterFees ??
          null,
        bestTotalFeeRate:
          best?.totalFeeRate ??
          null,
        bestTotalFeeInStartAsset:
          best?.totalFeeInStartAsset ??
          null,
        bestNetRoi:
          best?.netRoi ?? null,
        bestExpectedProfit:
          best?.expectedProfit ??
          null,
        minGrossRoiAfterFees:
          config.trading.minGrossRoiAfterFees,
        minNetRoi:
          config.trading.minNetRoi,
        takerFeeRate:
          config.trading.takerFeeRate,
        safetyBufferRate:
          config.trading.safetyBufferRate,
        maxExecutionBookAgeMs:
          MAX_EXECUTION_BOOK_AGE_MS,
        bookAges,
        staleBooksCount:
          staleBooks.length
      }
    );

    if (
      best &&
      this.bestRouteWriter
    ) {
      const bestTriangle =
        this.triangles.find(
          (triangle) =>
            triangle.id ===
            best.triangleId
        );

      void this.bestRouteWriter
        .write(
          best,
          bestTriangle
        )
        .catch((error) => {
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

    this.lastDiagnosticsAt =
      now;
  }
}
