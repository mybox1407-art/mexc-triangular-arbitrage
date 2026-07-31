src/services/ArbitrageCalculator.ts

import { config } from '../config.js';
import { OrderBook } from '../domain/orderBook.js';
import type {
  BookLevel,
  Opportunity,
  SimulatedLeg,
  Triangle,
  TriangleLeg
} from '../domain/types.js';
import pino from 'pino';

const logger = pino({ level: config.logLevel });

export class ArbitrageCalculator {
  constructor(
    private readonly takerFeesBySymbol = new Map<string, number>()
  ) {}

  simulate(
    triangle: Triangle,
    books: Map<string, OrderBook>,
    startAmount: number
  ): Opportunity | null {
    // 1. Симуляция треугольника без комиссий — "идеальный" ROI.
    let amountBeforeFees = startAmount;

    for (const leg of triangle.legs) {
      const book = books.get(leg.symbol);
      if (!book) {
        return null;
      }

      const snapshot = book.getSnapshot(100);
      if (!snapshot.ready) {
        return null;
      }

      if (leg.side === 'BUY') {
        const exec = this.buyWithQuote(snapshot.asks, amountBeforeFees);
        if (!exec) {
          return null;
        }
        amountBeforeFees = exec.baseAmount;
      } else {
        const exec = this.sellBase(snapshot.bids, amountBeforeFees);
        if (!exec) {
          return null;
        }
        amountBeforeFees = exec.quoteReceived;
      }
    }

    const finalAmountBeforeFees = amountBeforeFees;
    const grossRoiBeforeFees =
      (finalAmountBeforeFees - startAmount) / startAmount;

    // 2. Симуляция треугольника с комиссией takerFeeRate по каждой паре.
    let amountAfterFees = startAmount;
    const simulatedLegs: SimulatedLeg[] = [];

    for (const leg of triangle.legs) {
      const book = books.get(leg.symbol);
      if (!book) {
        return null;
      }

      const snapshot = book.getSnapshot(100);
      if (!snapshot.ready) {
        return null;
      }

      const feeRate = this.getTakerFeeRate(leg.symbol);

      const result = this.simulateLeg(
        leg,
        snapshot.bids,
        snapshot.asks,
        amountAfterFees,
        feeRate
      );

      if (!result) {
        return null;
      }

      amountAfterFees = result.outputAmount;
      simulatedLegs.push(result);
    }

    const finalAmountAfterFees = amountAfterFees;
    const grossRoiAfterFees =
      (finalAmountAfterFees - startAmount) / startAmount;

    // 3. Safety buffer сверху.
    const netRoi = grossRoiAfterFees - config.trading.safetyBufferRate;

    // 4. Суммарная комиссия как доля от стартового ассета — разница ROI до/после фи.
    const totalFeeRate = grossRoiBeforeFees - grossRoiAfterFees;
    const totalFeeInStartAsset = totalFeeRate * startAmount;

    // === ДОБАВЛЕНО: Метрики исполнения ===
    const maxLevelsUsed = Math.max(...simulatedLegs.map(leg => leg.levelsUsed));
    const levelsPerLeg = simulatedLegs.map(leg => leg.levelsUsed);

    // === ДОБАВЛЕНО: Логирование метрик ===
    logger.info(
      {
        triangleId: triangle.id,
        maxLevelsUsed,
        levelsPerLeg,
        grossRoiBeforeFees,
        grossRoiAfterFees,
        netRoi,
        totalFeeRate
      },
      'Simulated triangle'
    );

    return {
      triangleId: triangle.id,
      startAsset: triangle.startAsset,
      startAmount,
      finalAmount: finalAmountAfterFees,
      grossRoiBeforeFees,
      grossRoiAfterFees,
      netRoi,
      totalFeeRate,
      totalFeeInStartAsset,
      expectedProfit: finalAmountAfterFees - startAmount,
      legs: simulatedLegs as [SimulatedLeg, SimulatedLeg, SimulatedLeg],
      detectedAt: new Date(),
      grossRoi: grossRoiAfterFees
    };
  }

  private getTakerFeeRate(symbol: string): number {
    const feeRate = this.takerFeesBySymbol.get(symbol.toUpperCase());

    if (
      feeRate === undefined ||
      !Number.isFinite(feeRate) ||
      feeRate < 0
    ) {
      return config.trading.takerFeeRate;
    }

    return feeRate;
  }

  private simulateLeg(
    leg: TriangleLeg,
    bids: BookLevel[],
    asks: BookLevel[],
    inputAmount: number,
    feeRate: number
  ): SimulatedLeg | null {
    if (leg.side === 'BUY') {
      const execution = this.buyWithQuote(asks, inputAmount);
      if (!execution) {
        return null;
      }

      const feePaidInOutput = execution.baseAmount * feeRate;
      const outputAmount = execution.baseAmount - feePaidInOutput;

      if (!Number.isFinite(outputAmount) || outputAmount <= 0) {
        return null;
      }

      return {
        symbol: leg.symbol,
        side: 'BUY',
        fromAsset: leg.fromAsset,
        toAsset: leg.toAsset,
        inputAmount,
        outputAmount,
        vwap: execution.quoteSpent / execution.baseAmount,
        feePaidInOutput,
        levelsUsed: execution.levelsUsed
      };
    }

    const execution = this.sellBase(bids, inputAmount);
    if (!execution) {
      return null;
    }

    const feePaidInOutput = execution.quoteReceived * feeRate;
    const outputAmount = execution.quoteReceived - feePaidInOutput;

    if (!Number.isFinite(outputAmount) || outputAmount <= 0) {
      return null;
    }

    return {
      symbol: leg.symbol,
      side: 'SELL',
      fromAsset: leg.fromAsset,
      toAsset: leg.toAsset,
      inputAmount,
      outputAmount,
      vwap: execution.quoteReceived / inputAmount,
      feePaidInOutput,
      levelsUsed: execution.levelsUsed
    };
  }

  private buyWithQuote(
    asks: BookLevel[],
    quoteAmount: number
  ): {
    baseAmount: number;
    quoteSpent: number;
    levelsUsed: number;
  } | null {
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) {
      return null;
    }

    let quoteLeft = quoteAmount;
    let baseAmount = 0;
    let quoteSpent = 0;
    let levelsUsed = 0;

    for (const level of asks) {
      if (quoteLeft <= 1e-12) {
        break;
      }

      if (level.price <= 0 || level.quantity <= 0) {
        continue;
      }

      const maxQuoteAtLevel = level.price * level.quantity;
      const quoteAtLevel = Math.min(quoteLeft, maxQuoteAtLevel);
      const baseAtLevel = quoteAtLevel / level.price;

      baseAmount += baseAtLevel;
      quoteSpent += quoteAtLevel;
      quoteLeft -= quoteAtLevel;
      levelsUsed += 1;
    }

    if (quoteLeft > 1e-8 || baseAmount <= 0 || quoteSpent <= 0) {
      return null;
    }

    return {
      baseAmount,
      quoteSpent,
      levelsUsed
    };
  }

  private sellBase(
    bids: BookLevel[],
    baseAmount: number
  ): {
    quoteReceived: number;
    levelsUsed: number;
  } | null {
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return null;
    }

    let baseLeft = baseAmount;
    let quoteReceived = 0;
    let levelsUsed = 0;

    for (const level of bids) {
      if (baseLeft <= 1e-12) {
        break;
      }

      if (level.price <= 0 || level.quantity <= 0) {
        continue;
      }

      const baseAtLevel = Math.min(baseLeft, level.quantity);

      quoteReceived += baseAtLevel * level.price;
      baseLeft -= baseAtLevel;
      levelsUsed += 1;
    }

    if (baseLeft > 1e-8 || quoteReceived <= 0) {
      return null;
    }

    return {
      quoteReceived,
      levelsUsed
    };
  }
}
