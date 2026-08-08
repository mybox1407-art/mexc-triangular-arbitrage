import { MexcAuthenticatedClient } from '../mexc/MexcAuthenticatedClient.js';
import { OrderBook } from '../domain/orderBook.js';
import { Opportunity } from '../domain/types.js';

type Leg = Opportunity['legs'][number];

interface SymbolFilter {
  stepSize: number;
  tickSize: number;
  minNotional: number;
}

export interface OrderExecutionConfig {
  orderSizeBase: number;
  minProfitUsdt: number;
  maxRetries: number;
  retryDelayMs: number;
  orderTimeoutMs: number;
  enabled: boolean;
  useMarketOrders: boolean;
  aggressivePriceRate: number;
  minOrderNotional?: number;
  marketBuyBufferRate?: number;
  defaultQuantityPrecision?: number;
  maxExecutionDeviationRate?: number;
  symbolFilters?: Map<string, SymbolFilter>;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  filledQuantity?: number;
  receivedQuantity?: number;
  executedPrice?: number;
  executedQuoteQty?: number;
  timestamp: number;
  isMarketOrder?: boolean;
}

export interface ExecutionReport {
  opportunity: Opportunity;
  orders: OrderResult[];
  totalProfitUsdt: number;
  totalFeesUsdt: number;
  executionTimeMs: number;
  status: 'executed' | 'partial' | 'failed' | 'cancelled';
  actualFinalAmount?: number;
  profitIsActual?: boolean;
}

interface RawOrderStatus {
  status: string;
  executedQty?: string;
  avgPrice?: string;
  price?: string;
  cummulativeQuoteQty?: string;
  cumulativeQuoteQty?: string;
}

const NON_RETRYABLE_PATTERNS = [
  '"code":30002',
  '"code":30005',
  '"code":100002',
  '"code":100003',
  'minimum transaction volume',
  'insufficient balance'
];

export class OrderExecutionService {
  private client: MexcAuthenticatedClient;
  private orderBooks: Map<string, OrderBook>;
  private config: OrderExecutionConfig;

  private activeOrders: Map<
    string,
    {
      orderId: string;
      symbol: string;
      side: 'BUY' | 'SELL';
      timestamp: number;
    }
  > = new Map();

  constructor(
    client: MexcAuthenticatedClient,
    orderBooks: Map<string, OrderBook>,
    config: OrderExecutionConfig
  ) {
    this.client = client;
    this.orderBooks = orderBooks;

    this.config = {
      minOrderNotional: 1,
      marketBuyBufferRate: 0.003,
      defaultQuantityPrecision: 6,
      maxExecutionDeviationRate: 0.02,
      ...config
    };
  }

  private getBestBid(symbol: string): number {
    const book = this.orderBooks.get(symbol);

    if (!book) {
      throw new Error(`Order book not found for ${symbol}`);
    }

    const snapshot = book.getSnapshot(5);

    if (snapshot.bids.length === 0) {
      throw new Error(`No bids for ${symbol}`);
    }

    return snapshot.bids[0].price;
  }

  private getBestAsk(symbol: string): number {
    const book = this.orderBooks.get(symbol);

    if (!book) {
      throw new Error(`Order book not found for ${symbol}`);
    }

    const snapshot = book.getSnapshot(5);

    if (snapshot.asks.length === 0) {
      throw new Error(`No asks for ${symbol}`);
    }

    return snapshot.asks[0].price;
  }

  async executeArbitrage(
    opportunity: Opportunity
  ): Promise<ExecutionReport> {
    const startTime = Date.now();
    const orders: OrderResult[] = [];

    if (!this.config.enabled) {
      console.log('[EXEC] CANCELLED: trading disabled');

      return {
        opportunity,
        orders: [],
        totalProfitUsdt: 0,
        totalFeesUsdt: 0,
        executionTimeMs: 0,
        status: 'cancelled'
      };
    }

    const profitUsdt = opportunity.expectedProfit;

    console.log(
      `[EXEC] profitUsdt=${profitUsdt.toFixed(6)}, ` +
      `minProfitUsdt=${this.config.minProfitUsdt}`
    );

    if (profitUsdt < this.config.minProfitUsdt) {
      console.log(
        `[EXEC] CANCELLED: profit ${profitUsdt.toFixed(4)} ` +
        `< minProfit ${this.config.minProfitUsdt}`
      );

      return {
        opportunity,
        orders: [],
        totalProfitUsdt: 0,
        totalFeesUsdt: 0,
        executionTimeMs: 0,
        status: 'cancelled'
      };
    }

    const minNotional = this.config.minOrderNotional!;

    if (opportunity.startAmount < minNotional) {
      console.error(
        `[EXEC] CANCELLED: startAmount ${opportunity.startAmount} ` +
        `< minNotional ${minNotional}`
      );

      return {
        opportunity,
        orders: [],
        totalProfitUsdt: 0,
        totalFeesUsdt: 0,
        executionTimeMs: 0,
        status: 'cancelled'
      };
    }

    console.log(
      '[PREFLIGHT]',
      JSON.stringify({
        startAmount: opportunity.startAmount,
        legs: opportunity.legs.map((leg) => ({
          symbol: leg.symbol,
          side: leg.side,
          estOutput: leg.outputAmount
        }))
      })
    );

    console.log(
      `[EXEC] Starting arbitrage: ${opportunity.triangleId}`
    );

    console.log(
      `[EXEC] Expected profit: $${profitUsdt.toFixed(2)}`
    );

    console.log(
      `[EXEC] Order type: ${
        this.config.useMarketOrders ? 'MARKET' : 'LIMIT'
      }`
    );

    try {
      const order1 = await this.executeLeg(
        0,
        opportunity,
        opportunity.startAmount
      );

      orders.push(order1);

      if (!order1.success) {
        console.error(`[EXEC] Step 1 failed: ${order1.error}`);

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'failed'
        );
      }

      const input2 = this.resolveNextInput(
        order1,
        opportunity.legs[0],
        'step1'
      );

      const order2 = await this.executeLeg(
        1,
        opportunity,
        input2
      );

      orders.push(order2);

      if (!order2.success) {
        console.error(`[EXEC] Step 2 failed: ${order2.error}`);

        console.error(
          `[EXEC] RESIDUAL POSITION: ~${order1.receivedQuantity} ` +
          `of leg-1 output asset is open. Manual unwind required.`
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'partial'
        );
      }

      const input3 = this.resolveNextInput(
        order2,
        opportunity.legs[1],
        'step2'
      );

      const order3 = await this.executeLeg(
        2,
        opportunity,
        input3
      );

      orders.push(order3);

      if (!order3.success) {
        console.error(`[EXEC] Step 3 failed: ${order3.error}`);

        console.error(
          `[EXEC] RESIDUAL POSITION: ~${order2.receivedQuantity} ` +
          `of leg-2 output asset is open. Manual unwind required.`
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'partial'
        );
      }

      this.checkExecutionInvariant(
        opportunity,
        order3
      );

      console.log(
        `[EXEC] Arbitrage completed successfully: ${opportunity.triangleId}`
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'executed'
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[EXEC] Critical error: ${errorMessage}`
      );

      return {
        opportunity,
        orders,
        totalProfitUsdt: 0,
        totalFeesUsdt: 0,
        executionTimeMs: Date.now() - startTime,
        status: 'failed'
      };
    }
  }

  private resolveNextInput(
    prevResult: OrderResult,
    prevLeg: Leg,
    label: string
  ): number {
    if (
      prevResult.receivedQuantity &&
      prevResult.receivedQuantity > 0
    ) {
      return prevResult.receivedQuantity;
    }

    console.warn(
      `[EXEC] ${label}: receivedQuantity unavailable, ` +
      `falling back to simulated outputAmount=${prevLeg.outputAmount}`
    );

    return prevLeg.outputAmount;
  }

  private async executeLeg(
    legIndex: number,
    opportunity: Opportunity,
    inputAmount: number
  ): Promise<OrderResult> {
    const leg = opportunity.legs[legIndex];
    const step = legIndex + 1;

    if (!inputAmount || inputAmount <= 0) {
      return {
        success: false,
        error: `Invalid input amount for step ${step}: ${inputAmount}`,
        timestamp: Date.now()
      };
    }

    if (leg.side === 'BUY') {
      if (inputAmount < this.config.minOrderNotional!) {
        return {
          success: false,
          error:
            `Step ${step}: quote amount ${inputAmount} ` +
            `below minNotional ${this.config.minOrderNotional}`,
          timestamp: Date.now()
        };
      }

      console.log(
        `[STEP${step}] BUY ${leg.symbol}, ` +
        `spending: ${inputAmount} (quote)`
      );
    } else {
      console.log(
        `[STEP${step}] SELL ${leg.symbol}, ` +
        `selling: ${inputAmount} (base)`
      );
    }

    return this.placeOrder(
      leg.symbol,
      leg.side,
      inputAmount
    );
  }

  private floorToStep(
    value: number,
    step: number
  ): number {
    const stepped = Math.floor(value / step) * step;

    return parseFloat(
      stepped.toFixed(8)
    );
  }

  private roundQuantity(
    symbol: string,
    quantity: number
  ): number {
    const filter = this.config.symbolFilters?.get(symbol);

    if (filter && filter.stepSize > 0) {
      return this.floorToStep(
        quantity,
        filter.stepSize
      );
    }

    const precision =
      this.config.defaultQuantityPrecision!;

    const factor = 10 ** precision;

    return Math.floor(quantity * factor) / factor;
  }

  private async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    inputAmount: number
  ): Promise<OrderResult> {
    for (
      let attempt = 1;
      attempt <= this.config.maxRetries;
      attempt++
    ) {
      try {
        let price: number | undefined;
        let quantity: number;

        const orderType: 'MARKET' | 'LIMIT' =
          this.config.useMarketOrders
            ? 'MARKET'
            : 'LIMIT';

        if (side === 'BUY') {
          /*
           * inputAmount is quote asset amount.
           *
           * Example:
           * 10 USDT / 59.09 USDT per QNT
           * = approximately 0.169 QNT.
           */
          if (orderType === 'MARKET') {
            const askWithBuffer =
              this.getBestAsk(symbol) *
              (1 + this.config.marketBuyBufferRate!);

            quantity = this.roundQuantity(
              symbol,
              inputAmount / askWithBuffer
            );
          } else {
            price =
              this.getBestAsk(symbol) *
              (1 + this.config.aggressivePriceRate);

            quantity = this.roundQuantity(
              symbol,
              inputAmount / price
            );
          }
        } else {
          /*
           * For SELL, inputAmount is base asset amount.
           */
          quantity = this.roundQuantity(
            symbol,
            inputAmount
          );

          if (orderType === 'LIMIT') {
            price =
              this.getBestBid(symbol) *
              (1 - this.config.aggressivePriceRate);
          }
        }

        if (
          price !== undefined &&
          (!price || price <= 0)
        ) {
          throw new Error(
            `Invalid price for ${symbol}: ${price}`
          );
        }

        if (!quantity || quantity <= 0) {
          throw new Error(
            `Invalid quantity for ${symbol}: ${quantity} ` +
            `(input=${inputAmount})`
          );
        }

        const notional =
          side === 'BUY'
            ? inputAmount
            : quantity * this.getBestBid(symbol);

        const filter =
          this.config.symbolFilters?.get(symbol);

        const minNotional =
          filter?.minNotional ??
          this.config.minOrderNotional!;

        if (notional < minNotional) {
          return {
            success: false,
            error:
              `Order below minNotional: ${symbol} ` +
              `notional=${notional.toFixed(4)} ` +
              `< min=${minNotional}`,
            timestamp: Date.now()
          };
        }

        console.log(
          '[ORDER REQUEST]',
          JSON.stringify({
            symbol,
            side,
            orderType,
            quantity,
            price: price ?? 'MARKET',
            estNotional: parseFloat(
              notional.toFixed(6)
            )
          })
        );

        const order =
          await this.client.placeOrder({
            symbol: symbol.toUpperCase(),
            side,
            orderType,
            price: price?.toString(),
            quantity: quantity.toString(),
            timeInForce:
              orderType === 'LIMIT'
                ? 'GTC'
                : undefined
          });

        console.log(
          `[ORDER] Placed: ${order.orderId} ` +
          `${orderType} ${side} ${symbol} ` +
          `@ ${price || 'MARKET'} × ${quantity}`
        );

        this.activeOrders.set(order.orderId, {
          orderId: order.orderId,
          symbol,
          side,
          timestamp: Date.now()
        });

        const result =
          await this.waitForOrderExecution(
            order.orderId,
            symbol,
            side
          );

        this.activeOrders.delete(
          order.orderId
        );

        return result;
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `[RETRY] Attempt ${attempt}/` +
          `${this.config.maxRetries} failed: ` +
          errorMessage
        );

        if (
          this.isNonRetryable(errorMessage)
        ) {
          console.error(
            '[RETRY] Non-retryable error, aborting immediately'
          );

          return {
            success: false,
            error: errorMessage,
            timestamp: Date.now()
          };
        }

        if (
          attempt === this.config.maxRetries
        ) {
          return {
            success: false,
            error: errorMessage,
            timestamp: Date.now()
          };
        }

        await this.sleep(
          this.config.retryDelayMs
        );
      }
    }

    return {
      success: false,
      error: 'Max retries exceeded',
      timestamp: Date.now()
    };
  }

  private isNonRetryable(
    message: string
  ): boolean {
    return NON_RETRYABLE_PATTERNS.some(
      (pattern) => message.includes(pattern)
    );
  }

  private parseNum(
    value: unknown
  ): number {
    const number =
      typeof value === 'string'
        ? parseFloat(value)
        : NaN;

    return Number.isFinite(number)
      ? number
      : NaN;
  }

  private async waitForOrderExecution(
    orderId: string,
    symbol: string,
    side: 'BUY' | 'SELL'
  ): Promise<OrderResult> {
    const startTime = Date.now();

    while (
      Date.now() - startTime <
      this.config.orderTimeoutMs
    ) {
      try {
        const status =
          await this.client.getOrderStatus(
            orderId,
            symbol
          );

        const raw =
          status as unknown as RawOrderStatus;

        const executedQty =
          this.parseNum(raw.executedQty);

        let quoteQty =
          this.parseNum(
            raw.cummulativeQuoteQty ??
            raw.cumulativeQuoteQty
          );

        let avgPrice =
          this.parseNum(
            raw.avgPrice ??
            raw.price
          );

        if (
          !Number.isFinite(avgPrice) &&
          executedQty > 0 &&
          Number.isFinite(quoteQty) &&
          quoteQty > 0
        ) {
          avgPrice =
            quoteQty / executedQty;
        }

        if (
          !Number.isFinite(quoteQty) &&
          executedQty > 0 &&
          Number.isFinite(avgPrice) &&
          avgPrice > 0
        ) {
          quoteQty =
            executedQty * avgPrice;
        }

        console.log(
          `[STATUS] ${orderId}: ${raw.status} ` +
          `| executedQty=${executedQty} ` +
          `| avgPrice=${avgPrice} ` +
          `| quoteQty=${quoteQty}`
        );

        if (raw.status === 'FILLED') {
          const received =
            side === 'BUY'
              ? executedQty
              : quoteQty;

          console.log(
            `[ORDER] Filled: ${orderId} ` +
            `| qty=${executedQty} ` +
            `@ ${avgPrice} ` +
            `| received=${received}`
          );

          return {
            success: true,
            orderId,
            filledQuantity: executedQty,
            receivedQuantity: received,
            executedPrice: avgPrice,
            executedQuoteQty: quoteQty,
            timestamp: Date.now(),
            isMarketOrder:
              this.config.useMarketOrders
          };
        }

        if (
          raw.status === 'CANCELED' ||
          raw.status === 'REJECTED' ||
          raw.status === 'EXPIRED'
        ) {
          console.error(
            `[ORDER] ${orderId} ${raw.status}`
          );

          return {
            success: false,
            orderId,
            error: `Order ${raw.status}`,
            timestamp: Date.now()
          };
        }

        if (
          raw.status === 'PARTIALLY_FILLED'
        ) {
          console.warn(
            `[ORDER] ${orderId} ` +
            `PARTIALLY_FILLED ` +
            `| executedQty=${executedQty} ` +
            `| avgPrice=${avgPrice}`
          );
        }

        await this.sleep(100);
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `[STATUS] Error checking order ` +
          `${orderId}: ${errorMessage}`
        );

        await this.sleep(500);
      }
    }

    console.warn(
      `[TIMEOUT] Cancelling order ${orderId} ` +
      `after ${Date.now() - startTime}ms`
    );

    await this.attemptCancel(
      orderId,
      symbol
    );

    /*
     * Re-check after cancellation because the order
     * could have been partially filled.
     */
    try {
      const finalStatus =
        await this.client.getOrderStatus(
          orderId,
          symbol
        );

      const raw =
        finalStatus as unknown as RawOrderStatus;

      const executedQty =
        this.parseNum(raw.executedQty);

      let quoteQty =
        this.parseNum(
          raw.cummulativeQuoteQty ??
          raw.cumulativeQuoteQty
        );

      let avgPrice =
        this.parseNum(
          raw.avgPrice ??
          raw.price
        );

      if (
        !Number.isFinite(avgPrice) &&
        executedQty > 0 &&
        Number.isFinite(quoteQty) &&
        quoteQty > 0
      ) {
        avgPrice =
          quoteQty / executedQty;
      }

      if (
        !Number.isFinite(quoteQty) &&
        executedQty > 0 &&
        Number.isFinite(avgPrice) &&
        avgPrice > 0
      ) {
        quoteQty =
          executedQty * avgPrice;
      }

      if (executedQty > 0) {
        const received =
          side === 'BUY'
            ? executedQty
            : quoteQty;

        console.warn(
          `[TIMEOUT] Order ${orderId} ` +
          `partially filled after cancel: ` +
          `qty=${executedQty}, ` +
          `received=${received}`
        );

        return {
          success: true,
          orderId,
          filledQuantity: executedQty,
          receivedQuantity: received,
          executedPrice: avgPrice,
          executedQuoteQty: quoteQty,
          timestamp: Date.now(),
          isMarketOrder:
            this.config.useMarketOrders
        };
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[TIMEOUT] Failed to re-check order ` +
        `${orderId} after cancel: ${message}`
      );
    }

    return {
      success: false,
      orderId,
      error: 'Order timeout',
      timestamp: Date.now()
    };
  }

  private checkExecutionInvariant(
    opportunity: Opportunity,
    lastOrder: OrderResult
  ): void {
    const expectedFinal =
      (
        opportunity as Opportunity & {
          finalAmount?: number;
        }
      ).finalAmount;

    const actualFinal =
      lastOrder.receivedQuantity;

    if (
      !expectedFinal ||
      !actualFinal ||
      actualFinal <= 0
    ) {
      console.warn(
        '[INVARIANT] Cannot verify final amount: ' +
        'expected or actual missing'
      );

      return;
    }

    const deviation =
      Math.abs(
        actualFinal - expectedFinal
      ) / expectedFinal;

    const maxDeviation =
      this.config.maxExecutionDeviationRate!;

    console.log(
      `[INVARIANT] expectedFinal=${expectedFinal}, ` +
      `actualFinal=${actualFinal}, ` +
      `deviation=${(deviation * 100).toFixed(2)}%`
    );

    if (deviation > maxDeviation) {
      console.error(
        `[INVARIANT] VIOLATION: deviation ` +
        `${(deviation * 100).toFixed(2)}% exceeds ` +
        `${maxDeviation * 100}% — verify balances manually`
      );
    }
  }

  private async attemptCancel(
    orderId: string,
    symbol: string
  ): Promise<void> {
    try {
      await this.client.cancelOrder(
        orderId,
        symbol
      );

      console.log(
        `[CANCEL] Cancelled: ${orderId}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[CANCEL] Failed to cancel ${orderId}: ` +
        errorMessage
      );
    }
  }

  private createReport(
    opportunity: Opportunity,
    orders: OrderResult[],
    startTime: number,
    status:
      | 'executed'
      | 'partial'
      | 'failed'
      | 'cancelled'
  ): ExecutionReport {
    const fullyExecuted =
      status === 'executed' &&
      orders.length === 3 &&
      orders.every(
        (order) => order.success
      );

    const lastOrder =
      orders[orders.length - 1];

    const actualFinal =
      fullyExecuted
        ? lastOrder?.receivedQuantity
        : undefined;

    const actualProfit =
      fullyExecuted &&
      actualFinal &&
      actualFinal > 0
        ? actualFinal -
          opportunity.startAmount
        : 0;

    return {
      opportunity,
      orders,
      totalProfitUsdt: actualProfit,
      totalFeesUsdt:
        fullyExecuted
          ? opportunity.totalFeeInStartAsset
          : 0,
      executionTimeMs:
        Date.now() - startTime,
      status,
      actualFinalAmount: actualFinal,
      profitIsActual: fullyExecuted
    };
  }

  private sleep(
    ms: number
  ): Promise<void> {
    return new Promise(
      (resolve) => setTimeout(resolve, ms)
    );
  }

  enable(): void {
    this.config.enabled = true;
    console.log(
      '[EXEC] Trading ENABLED'
    );
  }

  disable(): void {
    this.config.enabled = false;
    console.log(
      '[EXEC] Trading DISABLED'
    );
  }

  async cancelAllActiveOrders(): Promise<void> {
    console.log(
      `[EXEC] Cancelling ` +
      `${this.activeOrders.size} active orders...`
    );

    const promises: Promise<void>[] = [];

    for (
      const [orderId, order]
      of this.activeOrders
    ) {
      promises.push(
        this.attemptCancel(
          orderId,
          order.symbol
        )
      );
    }

    await Promise.all(promises);
    this.activeOrders.clear();
  }

  getActiveOrdersCount(): number {
    return this.activeOrders.size;
  }
}
