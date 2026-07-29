import { config } from '../config.js';
import type {
  BookLevel,
  Opportunity,
  SimulatedLeg,
  Triangle,
  TriangleLeg
} from '../domain/types.js';
import { OrderBook } from '../domain/orderBook.js';

export class ArbitrageCalculator {
  simulate(
    triangle: Triangle,
    books: Map<string, OrderBook>,
    startAmount: number
  ): Opportunity | null {
    let amount = startAmount;
    const simulatedLegs: SimulatedLeg[] = [];

    for (const leg of triangle.legs) {
      const book = books.get(leg.symbol);
      if (!book) return null;

      const snapshot = book.getSnapshot(100);
      if (!snapshot.ready) return null;

      const result = this.simulateLeg(
        leg,
        snapshot.bids,
        snapshot.asks,
        amount
      );

      if (!result) return null;

      amount = result.outputAmount;
      simulatedLegs.push(result);
    }

    const finalAmount = amount;
    const grossRoi = (finalAmount - startAmount) / startAmount;
    const netRoi = grossRoi - config.trading.safetyBufferRate;

    return {
      triangleId: triangle.id,
      startAsset: triangle.startAsset,
      startAmount,
      finalAmount,
      grossRoi,
      netRoi,
      expectedProfit: finalAmount - startAmount,
      legs: simulatedLegs as [SimulatedLeg, SimulatedLeg, SimulatedLeg],
      detectedAt: new Date()
    };
  }

  private simulateLeg(
    leg: TriangleLeg,
    bids: BookLevel[],
    asks: BookLevel[],
    inputAmount: number
  ): SimulatedLeg | null {
    const feeRate = config.trading.takerFeeRate;

    if (leg.side === 'BUY') {
      const execution = this.buyWithQuote(asks, inputAmount);
      if (!execution) return null;

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
    if (!execution) return null;

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
      if (quoteLeft <= 1e-12) break;
      if (level.price <= 0 || level.quantity <= 0) continue;

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
      if (baseLeft <= 1e-12) break;
      if (level.price <= 0 || level.quantity <= 0) continue;

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
