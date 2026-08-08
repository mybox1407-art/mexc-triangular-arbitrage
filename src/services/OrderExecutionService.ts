import {
  MexcAuthenticatedClient
} from '../mexc/MexcAuthenticatedClient.js';

import { OrderBook } from '../domain/orderBook.js';
import { Opportunity } from '../domain/types.js';

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
  status:
    | 'executed'
    | 'partial'
    | 'failed'
    | 'cancelled';
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
  '"code":30003',
  '"code":30004',
  '"code":30005',
  '"code":100002',
  '"code":100003',
  'minimum transaction volume',
  'insufficient balance',
  'invalid quantity',
  'invalid price'
];

export class OrderExecutionService {
  private readonly client: MexcAuthenticatedClient;
  private readonly orderBooks: Map<string, OrderBook>;
  private readonly config: OrderExecutionConfig;

  private readonly activeOrders = new Map<
    string,
    {
      orderId: string;
      symbol: string;
      side: 'BUY' | 'SELL';
      timestamp: number;
    }
  >();

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
      throw new Error(
        `Order book not found for ${symbol}`
      );
    }

    const snapshot = book.getSnapshot(5);

    if (snapshot.bids.length === 0) {
      throw new Error(
        `No bids for ${symbol}`
      );
    }

    return snapshot.bids[0].price;
  }

  private getBestAsk(symbol: string): number {
    const book = this.orderBooks.get(symbol);

    if (!book) {
      throw new Error(
        `Order book not found for ${symbol}`
      );
    }

    const snapshot = book.getSnapshot(5);

    if (snapshot.asks.length === 0) {
      throw new Error(
        `No asks for ${symbol}`
      );
    }

    return snapshot.asks[0].price;
  }

  async executeArbitrage(
    opportunity: Opportunity
  ): Promise<ExecutionReport> {
    const startTime = Date.now();
    const orders: OrderResult[] = [];

    if (!this.config.enabled) {
      console.log(
        '[EXEC] CANCELLED: trading disabled'
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'cancelled'
      );
    }

    const expectedProfit =
      opportunity.expectedProfit;

    if (
      !Number.isFinite(expectedProfit) ||
      expectedProfit < this.config.minProfitUsdt
    ) {
      console.log(
        `[EXEC] CANCELLED: invalid or insufficient profit ` +
        `profit=${expectedProfit}, ` +
        `min=${this.config.minProfitUsdt}`
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'cancelled'
      );
    }

    const minNotional =
      this.config.minOrderNotional ?? 1;

    if (
      !Number.isFinite(opportunity.startAmount) ||
      opportunity.startAmount < minNotional
    ) {
      console.log(
        `[EXEC] CANCELLED: invalid start amount ` +
        `${opportunity.startAmount}`
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'cancelled'
      );
    }

    console.log(
      '[PREFLIGHT]',
      JSON.stringify({
        triangleId: opportunity.triangleId,
        startAsset: opportunity.startAsset,
        startAmount: opportunity.startAmount,
        legs: opportunity.legs.map((leg) => ({
          symbol: leg.symbol,
          side: leg.side,
          fromAsset: leg.fromAsset,
          toAsset: leg.toAsset,
          outputAmount: leg.outputAmount
        }))
      })
    );

    try {
      const order1 = await this.executeLeg(
        0,
        opportunity,
        opportunity.startAmount
      );

      orders.push(order1);

      if (!order1.success) {
        console.error(
          `[EXEC] Step 1 failed: ${order1.error}`
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'failed'
        );
      }

      const input2 =
        this.resolveNextInput(order1, 'step1');

      const order2 = await this.executeLeg(
        1,
        opportunity,
        input2
      );

      orders.push(order2);

      if (!order2.success) {
        console.error(
          `[EXEC] Step 2 failed: ${order2.error}`
        );

        this.logResidualPosition(
          'step2',
          order1
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'partial'
        );
      }

      const input3 =
        this.resolveNextInput(order2, 'step2');

      const order3 = await this.executeLeg(
        2,
        opportunity,
        input3
      );

      orders.push(order3);

      if (!order3.success) {
        console.error(
          `[EXEC] Step 3 failed: ${order3.error}`
        );

        this.logResidualPosition(
          'step3',
          order2
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'partial'
        );
      }

      const invariantOk =
        this.checkExecutionInvariant(
          opportunity,
          order3
        );

      if (!invariantOk) {
        console.error(
          '[EXEC] Final invariant failed'
        );

        return this.createReport(
          opportunity,
          orders,
          startTime,
          'partial'
        );
      }

      console.log(
        `[EXEC] Arbitrage completed successfully: ` +
        `${opportunity.triangleId}`
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'executed'
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[EXEC] Critical error: ${message}`
      );

      return this.createReport(
        opportunity,
        orders,
        startTime,
        'failed'
      );
    }
  }

  private resolveNextInput(
    result: OrderResult,
    label: string
  ): number {
    const received =
      result.receivedQuantity;

    if (
      received === undefined ||
      !Number.isFinite(received) ||
      received <= 0
    ) {
      throw new Error(
        `${label}: actual received quantity is missing; ` +
        'refusing to continue with simulated amount'
      );
    }

    return received;
  }

  private async executeLeg(
    legIndex: number,
    opportunity: Opportunity,
    inputAmount: number
  ): Promise<OrderResult> {
    const leg =
      opportunity.legs[legIndex];

    if (!leg) {
      return {
        success: false,
        error: `Missing leg ${legIndex + 1}`,
        timestamp: Date.now()
      };
    }

    const step = legIndex + 1;

    if (
      !Number.isFinite(inputAmount) ||
      inputAmount <= 0
    ) {
      return {
        success: false,
        error:
          `Invalid input amount at step ${step}: ` +
          `${inputAmount}`,
        timestamp: Date.now()
      };
    }

    if (
      leg.side === 'BUY' &&
      inputAmount <
        (this.config.minOrderNotional ?? 1)
    ) {
      return {
        success: false,
        error:
          `BUY quote amount ${inputAmount} ` +
          'is below minimum notional',
        timestamp: Date.now()
      };
    }

    console.log(
      leg.side === 'BUY'
        ? `[STEP${step}] BUY ${leg.symbol}, ` +
          `spending ${inputAmount} quote`
        : `[STEP${step}] SELL ${leg.symbol}, ` +
          `selling ${inputAmount} base`
    );

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
    if (
      !Number.isFinite(step) ||
      step <= 0
    ) {
      return value;
    }

    return Number(
      (Math.floor(value / step) * step)
        .toFixed(12)
    );
  }

  private roundQuantity(
    symbol: string,
    quantity: number
  ): number {
    const filter =
      this.config.symbolFilters?.get(symbol);

    if (
      filter &&
      Number.isFinite(filter.stepSize) &&
      filter.stepSize > 0
    ) {
      return this.floorToStep(
        quantity,
        filter.stepSize
      );
    }

    const precision =
      this.config.defaultQuantityPrecision ?? 6;

    const factor =
      10 ** precision;

    return Math.floor(
      quantity * factor
    ) / factor;
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
        const orderType =
          this.config.useMarketOrders
            ? 'MARKET'
            : 'LIMIT';

        let quantity: number | undefined;
        let price: number | undefined;

        /*
         * MARKET BUY:
         *
         * inputAmount = quote amount.
         * Example: 10 USDT.
         *
         * The MEXC request uses quoteOrderQty,
         * not quantity.
         */
        if (
          side === 'BUY' &&
          orderType === 'MARKET'
        ) {
          const minNotional =
            this.config.minOrderNotional ?? 1;

          if (inputAmount < minNotional) {
            return {
              success: false,
              error:
                `BUY quote amount ${inputAmount} ` +
                `below minNotional ${minNotional}`,
              timestamp: Date.now()
            };
          }

          console.log(
            '[ORDER REQUEST]',
            JSON.stringify({
              symbol,
              side,
              orderType,
              quantity: null,
              quoteOrderQty:
                inputAmount.toFixed(8)
            })
          );

          const order =
            await this.client.placeOrder({
              symbol: symbol.toUpperCase(),
              side,
              orderType,
              quoteOrderQty:
                inputAmount.toFixed(8)
            });

          return this.waitForPlacedOrder(
            order.orderId,
            symbol,
            side
          );
        }

        /*
         * LIMIT BUY:
         * inputAmount is quote amount,
         * quantity is calculated base amount.
         */
        if (side === 'BUY') {
          price =
            this.getBestAsk(symbol) *
            (1 + this.config.aggressivePriceRate);

          quantity =
            this.roundQuantity(
              symbol,
              inputAmount / price
            );
        } else {
          /*
           * SELL:
           * inputAmount is base amount.
           */
          quantity =
            this.roundQuantity(
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
          quantity === undefined ||
          !Number.isFinite(quantity) ||
          quantity <= 0
        ) {
          throw new Error(
            `Invalid quantity for ${symbol}: ${quantity}`
          );
        }

        if (
          price !== undefined &&
          (!Number.isFinite(price) || price <= 0)
        ) {
          throw new Error(
            `Invalid price for ${symbol}: ${price}`
          );
        }

        const notional =
          side === 'SELL'
            ? quantity * this.getBestBid(symbol)
            : inputAmount;

        const filter =
          this.config.symbolFilters?.get(symbol);

        const minNotional =
          filter?.minNotional ??
          this.config.minOrderNotional ??
          1;

        if (notional < minNotional) {
          return {
            success: false,
            error:
              `Order below minNotional: ${symbol}, ` +
              `notional=${notional}, ` +
              `minimum=${minNotional}`,
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
            quoteOrderQty: null,
            price: price ?? null,
            estimatedNotional: notional
          })
        );

        const order =
          await this.client.placeOrder({
            symbol: symbol.toUpperCase(),
            side,
            orderType,
            quantity: quantity.toString(),
            price: price?.toString(),
            timeInForce:
              orderType === 'LIMIT'
                ? 'GTC'
                : undefined
          });

        return this.waitForPlacedOrder(
          order.orderId,
          symbol,
          side
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `[RETRY] Attempt ${attempt}/` +
          `${this.config.maxRetries}: ${message}`
        );

        if (
          this.isNonRetryable(message) ||
          attempt === this.config.maxRetries
        ) {
          return {
            success: false,
            error: message,
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

  private async waitForPlacedOrder(
    orderId: string,
    symbol: string,
    side: 'BUY' | 'SELL'
  ): Promise<OrderResult> {
    this.activeOrders.set(orderId, {
      orderId,
      symbol,
      side,
      timestamp: Date.now()
    });

    try {
      return await this.waitForOrderExecution(
        orderId,
        symbol,
        side
      );
    } finally {
      this.activeOrders.delete(orderId);
    }
  }

  private isNonRetryable(
    message: string
  ): boolean {
    return NON_RETRYABLE_PATTERNS.some(
      (pattern) => message.includes(pattern)
    );
  }

  private parseNumber(
    value: unknown
  ): number {
    const result =
      typeof value === 'number'
        ? value
        : Number(value);

    return Number.isFinite(result)
      ? result
      : NaN;
  }

  private async waitForOrderExecution(
    orderId: string,
    symbol: string,
    side: 'BUY' | 'SELL'
  ): Promise<OrderResult> {
    const startedAt = Date.now();

    while (
      Date.now() - startedAt <
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
          this.parseNumber(
            raw.executedQty
          );

        const quoteQty =
          this.parseNumber(
            raw.cummulativeQuoteQty ??
            raw.cumulativeQuoteQty
          );

        let avgPrice =
          this.parseNumber(
            raw.avgPrice ??
            raw.price
          );

        if (
          !Number.isFinite(avgPrice) &&
          executedQty > 0 &&
          quoteQty > 0
        ) {
          avgPrice =
            quoteQty / executedQty;
        }

        console.log(
          `[STATUS] ${orderId}: ${raw.status} ` +
          `| executedQty=${executedQty} ` +
          `| quoteQty=${quoteQty} ` +
          `| avgPrice=${avgPrice}`
        );

        if (raw.status === 'FILLED') {
          if (
            !Number.isFinite(executedQty) ||
            executedQty <= 0 ||
            !Number.isFinite(quoteQty) ||
            quoteQty <= 0
          ) {
            return {
              success: false,
              orderId,
              error:
                'MEXC returned invalid execution quantities',
              timestamp: Date.now()
            };
          }

          const received =
            side === 'BUY'
              ? executedQty
              : quoteQty;

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
          return {
            success: false,
            orderId,
            error:
              `Order ${raw.status}`,
            timestamp: Date.now()
          };
        }

        if (
          raw.status === 'PARTIALLY_FILLED' ||
          raw.status === 'PARTIALLY_CANCELED'
        ) {
          return {
            success: false,
            orderId,
            filledQuantity:
              Number.isFinite(executedQty)
                ? executedQty
                : undefined,
            receivedQuantity:
              side === 'BUY'
                ? executedQty
                : quoteQty,
            executedPrice: avgPrice,
            executedQuoteQty: quoteQty,
            error:
              `Order ${raw.status}`,
            timestamp: Date.now()
          };
        }

        await this.sleep(100);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `[STATUS] Error checking ${orderId}: ${message}`
        );

        await this.sleep(500);
      }
    }

    await this.attemptCancel(
      orderId,
      symbol
    );

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
  ): boolean {
    const expectedFinal = (
      opportunity as Opportunity & {
        finalAmount?: number;
      }
    ).finalAmount;

    const actualFinal =
      lastOrder.receivedQuantity;

    if (
      expectedFinal === undefined ||
      actualFinal === undefined ||
      !Number.isFinite(expectedFinal) ||
      !Number.isFinite(actualFinal) ||
      expectedFinal <= 0 ||
      actualFinal <= 0
    ) {
      console.error(
        '[INVARIANT] Missing final amount'
      );

      return false;
    }

    const deviation =
      Math.abs(actualFinal - expectedFinal) /
      expectedFinal;

    const maxDeviation =
      this.config.maxExecutionDeviationRate ?? 0.02;

    console.log(
      `[INVARIANT] expected=${expectedFinal}, ` +
      `actual=${actualFinal}, ` +
      `deviation=${(deviation * 100).toFixed(2)}%`
    );

    if (deviation > maxDeviation) {
      console.error(
        `[INVARIANT] FAILED: deviation ` +
        `${(deviation * 100).toFixed(2)}% > ` +
        `${(maxDeviation * 100).toFixed(2)}%`
      );

      return false;
    }

    return true;
  }

  private logResidualPosition(
    step: string,
    result: OrderResult
  ): void {
    console.error(
      `[EXEC] RESIDUAL POSITION after ${step}: ` +
      `filled=${result.filledQuantity}, ` +
      `received=${result.receivedQuantity}. ` +
      'Manual reconciliation required.'
    );
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
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[CANCEL] Failed to cancel ${orderId}: ${message}`
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

    const actualFinal =
      fullyExecuted
        ? orders[2]?.receivedQuantity
        : undefined;

    const actualProfit =
      fullyExecuted &&
      actualFinal !== undefined &&
      Number.isFinite(actualFinal)
        ? actualFinal -
          opportunity.startAmount
        : 0;

    return {
      opportunity,
      orders,
      totalProfitUsdt: actualProfit,
      totalFeesUsdt: 0,
      executionTimeMs:
        Date.now() - startTime,
      status,
      actualFinalAmount: actualFinal,
      profitIsActual: fullyExecuted
    };
  }

  private sleep(
    milliseconds: number
  ): Promise<void> {
    return new Promise(
      (resolve) => setTimeout(resolve, milliseconds)
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
    const cancellations =
      [...this.activeOrders.values()].map(
        (order) =>
          this.attemptCancel(
            order.orderId,
            order.symbol
          )
      );

    await Promise.all(cancellations);
    this.activeOrders.clear();
  }

  getActiveOrdersCount(): number {
    return this.activeOrders.size;
  }
}
