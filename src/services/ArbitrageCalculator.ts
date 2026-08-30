import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type {
  BookLevel,
  Opportunity,
  SimulatedLeg,
  Triangle,
  TriangleLeg
} from '../domain/types.js';
import type {
  SymbolFilter
} from './OrderExecutionService.js';
import pino from 'pino';

const logger = pino({
  level: config.logLevel
});

type BookSnapshotLike = {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ready: boolean;
  updatedAt: number;
};

type BuyExecution = {
  baseAmount: number;
  quoteSpent: number;
  levelsUsed: number;
  limitPrice: number;
};

type SellExecution = {
  quoteReceived: number;
  levelsUsed: number;
  limitPrice: number;
};

export class ArbitrageCalculator {
  private readonly maxRoundingLossRate =
    0.001;

  constructor(
    private readonly takerFeesBySymbol =
      new Map<string, number>(),
    private readonly symbolFilters =
      new Map<string, SymbolFilter>()
  ) {}

  simulate(
    triangle: Triangle,
    books: Map<string, OrderBook>,
    startAmount: number
  ): Opportunity | null {
    const snapshots =
      new Map<string, BookSnapshotLike>();

    for (const leg of triangle.legs) {
      const book =
        books.get(leg.symbol);

      if (!book) {
        return null;
      }

      const snapshot =
        book.getSnapshot(100);

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
    }

    return this.simulateFromSnapshots(
      triangle,
      snapshots,
      startAmount
    );
  }

  simulateFromSnapshots(
    triangle: Triangle,
    snapshots: Map<string, BookSnapshotLike>,
    startAmount: number
  ): Opportunity | null {
    if (
      !Number.isFinite(startAmount) ||
      startAmount <= 0
    ) {
      return null;
    }

    let amountBeforeFees =
      startAmount;

    for (const leg of triangle.legs) {
      const snapshot =
        snapshots.get(leg.symbol);

      if (
        !snapshot ||
        !snapshot.ready
      ) {
        return null;
      }

      const feeRate =
        this.getTakerFeeRate(
          leg.symbol
        );

      const result =
        this.simulateLeg(
          leg,
          snapshot.bids,
          snapshot.asks,
          amountBeforeFees,
          feeRate
        );

      if (!result) {
        return null;
      }

      amountBeforeFees =
        result.outputAmount;
    }

    const finalAmount =
      amountBeforeFees;

    const grossRoiAfterFees =
      (
        finalAmount -
        startAmount
      ) / startAmount;

    const netRoi =
      grossRoiAfterFees -
      config.trading.safetyBufferRate;

    if (
      !Number.isFinite(finalAmount) ||
      finalAmount <= 0
    ) {
      return null;
    }

    let amountBeforeFeesOnly =
      startAmount;

    for (const leg of triangle.legs) {
      const snapshot =
        snapshots.get(leg.symbol);

      if (!snapshot) {
        return null;
      }

      if (leg.side === 'BUY') {
        const result =
          this.buyWithQuote(
            leg.symbol,
            snapshot.asks,
            amountBeforeFeesOnly
          );

        if (!result) {
          return null;
        }

        amountBeforeFeesOnly =
          result.baseAmount;
      } else {
        const result =
          this.sellBase(
            leg.symbol,
            snapshot.bids,
            amountBeforeFeesOnly
          );

        if (!result) {
          return null;
        }

        amountBeforeFeesOnly =
          result.quoteReceived;
      }
    }

    const grossRoiBeforeFees =
      (
        amountBeforeFeesOnly -
        startAmount
      ) / startAmount;

    const totalFeeRate =
      grossRoiBeforeFees -
      grossRoiAfterFees;

    const totalFeeInStartAsset =
      totalFeeRate * startAmount;

    const simulatedLegs: SimulatedLeg[] =
      [];

    let amountAfterFees =
      startAmount;

    for (const leg of triangle.legs) {
      const snapshot =
        snapshots.get(leg.symbol);

      if (!snapshot) {
        return null;
      }

      const feeRate =
        this.getTakerFeeRate(
          leg.symbol
        );

      const result =
        this.simulateLeg(
          leg,
          snapshot.bids,
          snapshot.asks,
          amountAfterFees,
          feeRate
        );

      if (!result) {
        return null;
      }

      amountAfterFees =
        result.outputAmount;

      simulatedLegs.push(result);
    }

    if (
      simulatedLegs.length !== 3
    ) {
      return null;
    }

    return {
      triangleId: triangle.id,
      startAsset: triangle.startAsset,
      startAmount,
      finalAmount,
      grossRoiBeforeFees,
      grossRoiAfterFees,
      netRoi,
      totalFeeRate,
      totalFeeInStartAsset,
      expectedProfit:
        finalAmount - startAmount,
      legs:
        simulatedLegs as [
          SimulatedLeg,
          SimulatedLeg,
          SimulatedLeg
        ],
      detectedAt: new Date(),
      grossRoi: grossRoiAfterFees
    };
  }

  private getTakerFeeRate(
    symbol: string
  ): number {
    const feeRate =
      this.takerFeesBySymbol.get(
        symbol.toUpperCase()
      );

    if (
      feeRate === undefined ||
      !Number.isFinite(feeRate) ||
      feeRate < 0
    ) {
      return config.trading.takerFeeRate;
    }

    return feeRate;
  }

  private getFilter(
    symbol: string
  ): SymbolFilter | undefined {
    return this.symbolFilters.get(
      symbol.toUpperCase()
    );
  }

  private floorToStep(
    value: number,
    step: number
  ): number {
    if (
      !Number.isFinite(step) ||
      step <= 0
    ) {
      return value;
    }

    return Number(
      (
        Math.floor(value / step) *
        step
      ).toFixed(12)
    );
  }

  private roundBaseAmount(
    symbol: string,
    amount: number
  ): number | null {
    const filter =
      this.getFilter(symbol);

    if (!filter) {
      return amount;
    }

    const rounded =
      this.floorToStep(
        amount,
        filter.stepSize
      );

    if (
      !Number.isFinite(rounded) ||
      rounded <= 0
    ) {
      return null;
    }

    if (
      filter.minQuantity > 0 &&
      rounded < filter.minQuantity
    ) {
      return null;
    }

    const lossRate =
      amount > 0
        ? (amount - rounded) /
          amount
        : 0;

    if (
      lossRate >
      this.maxRoundingLossRate
    ) {
      logger.debug(
        {
          symbol,
          amount,
          rounded,
          lossRate
        },
        'Skipping opportunity because base rounding loss is too high'
      );

      return null;
    }

    return rounded;
  }

  private roundQuoteAmount(
    symbol: string,
    amount: number
  ): number | null {
    const filter =
      this.getFilter(symbol);

    if (!filter) {
      return amount;
    }

    if (
      filter.quoteScale < 0 ||
      !Number.isInteger(
        filter.quoteScale
      )
    ) {
      return amount;
    }

    const factor =
      10 ** filter.quoteScale;

    const rounded =
      Math.floor(
        amount * factor
      ) / factor;

    if (
      !Number.isFinite(rounded) ||
      rounded <= 0
    ) {
      return null;
    }

    const lossRate =
      amount > 0
        ? (amount - rounded) /
          amount
        : 0;

    if (
      lossRate >
      this.maxRoundingLossRate
    ) {
      logger.debug(
        {
          symbol,
          amount,
          rounded,
          lossRate
        },
        'Skipping opportunity because quote rounding loss is too high'
      );

      return null;
    }

    if (
      filter.minNotional > 0 &&
      rounded < filter.minNotional
    ) {
      return null;
    }

    return rounded;
  }

  private simulateLeg(
    leg: TriangleLeg,
    bids: BookLevel[],
    asks: BookLevel[],
    inputAmount: number,
    feeRate: number
  ): SimulatedLeg | null {
    // Adverse slippage buffer: 0.3%
    const stressRate = 0.003;

    const stressedAsks = leg.side === 'BUY'
      ? asks.map(level => ({
          ...level,
          price: level.price * (1 + stressRate)
        }))
      : asks;

    const stressedBids = leg.side === 'SELL'
      ? bids.map(level => ({
          ...level,
          price: level.price * (1 - stressRate)
        }))
      : bids;

    if (leg.side === 'BUY') {
      const execution =
        this.buyWithQuote(
          leg.symbol,
          stressedAsks,
          inputAmount
        );

      if (!execution) {
        return null;
      }

      const feePaidInOutput =
        execution.baseAmount *
        feeRate;

      const outputAmount =
        execution.baseAmount -
        feePaidInOutput;

      if (
        !Number.isFinite(outputAmount) ||
        outputAmount <= 0
      ) {
        return null;
      }

      return {
        symbol: leg.symbol,
        side: 'BUY',
        fromAsset: leg.fromAsset,
        toAsset: leg.toAsset,
        inputAmount,
        outputAmount,
        vwap:
          execution.quoteSpent /
          execution.baseAmount,
        expectedLimitPrice:
          execution.limitPrice,
        feePaidInOutput,
        levelsUsed:
          execution.levelsUsed
      };
    }

    const execution =
      this.sellBase(
        leg.symbol,
        stressedBids,
        inputAmount
      );

    if (!execution) {
      return null;
    }

    const feePaidInOutput =
      execution.quoteReceived *
      feeRate;

    const outputAmount =
      execution.quoteReceived -
      feePaidInOutput;

    if (
      !Number.isFinite(outputAmount) ||
      outputAmount <= 0
    ) {
      return null;
    }

    return {
      symbol: leg.symbol,
      side: 'SELL',
      fromAsset: leg.fromAsset,
      toAsset: leg.toAsset,
      inputAmount,
      outputAmount,
      vwap:
        execution.quoteReceived /
        (
          this.roundBaseAmount(
            leg.symbol,
            inputAmount
          ) ?? inputAmount
        ),
      expectedLimitPrice:
        execution.limitPrice,
      feePaidInOutput,
      levelsUsed:
        execution.levelsUsed
    };
  }

  private buyWithQuote(
    symbol: string,
    asks: BookLevel[],
    quoteAmount: number
  ): BuyExecution | null {
    const roundedQuote =
      this.roundQuoteAmount(
        symbol,
        quoteAmount
      );

    if (
      roundedQuote === null ||
      roundedQuote <= 0
    ) {
      return null;
    }

    let quoteLeft =
      roundedQuote;

    let baseAmount = 0;
    let quoteSpent = 0;
    let levelsUsed = 0;
    let limitPrice = 0;

    for (const level of asks) {
      if (
        quoteLeft <= 1e-12
      ) {
        break;
      }

      if (
        !Number.isFinite(level.price) ||
        !Number.isFinite(level.quantity) ||
        level.price <= 0 ||
        level.quantity <= 0
      ) {
        continue;
      }

      const maxQuoteAtLevel =
        level.price *
        level.quantity;

      const quoteAtLevel =
        Math.min(
          quoteLeft,
          maxQuoteAtLevel
        );

      const baseAtLevel =
        quoteAtLevel /
        level.price;

      baseAmount +=
        baseAtLevel;

      quoteSpent +=
        quoteAtLevel;

      quoteLeft -=
        quoteAtLevel;

      levelsUsed += 1;

      limitPrice =
        level.price;
    }

    if (
      quoteLeft > 1e-8 ||
      baseAmount <= 0 ||
      quoteSpent <= 0 ||
      limitPrice <= 0
    ) {
      return null;
    }

    const roundedBase =
      this.roundBaseAmount(
        symbol,
        baseAmount
      );

    if (
      roundedBase === null ||
      roundedBase <= 0
    ) {
      return null;
    }

    // ИСПРАВЛЕНИЕ: пересчитываем quoteSpent для округлённого baseAmount
    let actualQuoteSpent = 0;
    let baseAccumulated = 0;

    for (const level of asks) {
      if (baseAccumulated >= roundedBase) break;

      const baseAvailableAtLevel = level.quantity;
      const baseNeeded = roundedBase - baseAccumulated;
      const baseAtLevel = Math.min(baseNeeded, baseAvailableAtLevel);

      actualQuoteSpent += baseAtLevel * level.price;
      baseAccumulated += baseAtLevel;
    }

    if (actualQuoteSpent > roundedQuote) {
      return null;
    }

    return {
      baseAmount: roundedBase,
      quoteSpent: actualQuoteSpent,
      levelsUsed,
      limitPrice
    };
  }

  private sellBase(
    symbol: string,
    bids: BookLevel[],
    baseAmount: number
  ): SellExecution | null {
    const roundedBase =
      this.roundBaseAmount(
        symbol,
        baseAmount
      );

    if (
      roundedBase === null ||
      roundedBase <= 0
    ) {
      return null;
    }

    let baseLeft =
      roundedBase;

    let quoteReceived = 0;
    let levelsUsed = 0;
    let limitPrice = 0;

    for (const level of bids) {
      if (
        baseLeft <= 1e-12
      ) {
        break;
      }

      if (
        !Number.isFinite(level.price) ||
        !Number.isFinite(level.quantity) ||
        level.price <= 0 ||
        level.quantity <= 0
      ) {
        continue;
      }

      const baseAtLevel =
        Math.min(
          baseLeft,
          level.quantity
        );

      quoteReceived +=
        baseAtLevel *
        level.price;

      baseLeft -=
        baseAtLevel;

      levelsUsed += 1;

      limitPrice =
        level.price;
    }

    if (
      baseLeft > 1e-8 ||
      quoteReceived <= 0 ||
      limitPrice <= 0
    ) {
      return null;
    }

    return {
      quoteReceived,
      levelsUsed,
      limitPrice
    };
  }
}
