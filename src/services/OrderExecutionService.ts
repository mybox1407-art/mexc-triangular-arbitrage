import { MexcAuthenticatedClient } from '../mexc/MexcAuthenticatedClient.js';
import { OrderBook } from '../domain/orderBook.js';
import { ArbitrageOpportunity } from '../domain/types.js';

export interface OrderExecutionConfig {
  orderSizeBase: number;
  minProfitUsdt: number;
  maxRetries: number;
  retryDelayMs: number;
  orderTimeoutMs: number;
  enabled: boolean;
  useMarketOrders: boolean;
  aggressivePriceRate: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  filledQuantity?: number;
  executedPrice?: number;
  timestamp: number;
  isMarketOrder?: boolean;
}

export interface ExecutionReport {
  opportunity: ArbitrageOpportunity;
  orders: OrderResult[];
  totalProfitUsdt: number;
  totalFeesUsdt: number;
  executionTimeMs: number;
  status: 'executed' | 'partial' | 'failed' | 'cancelled';
}

export class OrderExecutionService {
  private client: MexcAuthenticatedClient;
  private orderBooks: Map<string, OrderBook>;
  private config: OrderExecutionConfig;
  private activeOrders: Map<string, {
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    timestamp: number;
  }> = new Map();

  constructor(
    client: MexcAuthenticatedClient,
    orderBooks: Map<string, OrderBook>,
    config: OrderExecutionConfig
  ) {
    this.client = client;
    this.orderBooks = orderBooks;
    this.config = config;
  }

  private getBestBid(symbol: string): number {
    const book = this.orderBooks.get(symbol);
    if (!book) throw new Error(`Order book not found for ${symbol}`);
    const snapshot = book.getSnapshot(5);
    if (snapshot.bids.length === 0) throw new Error(`No bids for ${symbol}`);
    return snapshot.bids[0].price;
  }

  private getBestAsk(symbol: string): number {
    const book = this.orderBooks.get(symbol);
    if (!book) throw new Error(`Order book not found for ${symbol}`);
    const snapshot = book.getSnapshot(5);
    if (snapshot.asks.length === 0) throw new Error(`No asks for ${symbol}`);
    return snapshot.asks[0].price;
  }

  async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionReport> {
    const startTime = Date.now();
    const orders: OrderResult[] = [];

    if (!this.config.enabled) {
      return { opportunity, orders: [], totalProfitUsdt: 0, totalFeesUsdt: 0, executionTimeMs: 0, status: 'cancelled' };
    }

    if (opportunity.profitUsdt < this.config.minProfitUsdt) {
      return { opportunity, orders: [], totalProfitUsdt: 0, totalFeesUsdt: 0, executionTimeMs: 0, status: 'cancelled' };
    }

    console.log(`[EXEC] Starting arbitrage: ${opportunity.triangle.base}→${opportunity.triangle.quote}→${opportunity.triangle.intermediate}`);
    console.log(`[EXEC] Expected profit: $${opportunity.profitUsdt.toFixed(2)}`);
    console.log(`[EXEC] Order type: ${this.config.useMarketOrders ? 'MARKET' : 'LIMIT'}`);

    try {
      const order1 = await this.executeStep1(opportunity.triangle, opportunity);
      orders.push(order1);

      if (!order1.success) {
        console.error(`[EXEC] Step 1 failed: ${order1.error}`);
        return this.createReport(opportunity, orders, startTime, 'failed');
      }

      const order2 = await this.executeStep2(opportunity.triangle, opportunity, order1);
      orders.push(order2);

      if (!order2.success) {
        console.error(`[EXEC] Step 2 failed: ${order2.error}`);
        await this.attemptCancel(order1.orderId!, opportunity.triangle);
        return this.createReport(opportunity, orders, startTime, 'partial');
      }

      const order3 = await this.executeStep3(opportunity.triangle, opportunity, order2);
      orders.push(order3);

      if (!order3.success) {
        console.error(`[EXEC] Step 3 failed: ${order3.error}`);
        await this.attemptCancel(order1.orderId!, opportunity.triangle);
        await this.attemptCancel(order2.orderId!, opportunity.triangle);
        return this.createReport(opportunity, orders, startTime, 'partial');
      }

      return this.createReport(opportunity, orders, startTime, 'executed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[EXEC] Critical error: ${errorMessage}`);
      return { opportunity, orders, totalProfitUsdt: 0, totalFeesUsdt: 0, executionTimeMs: Date.now() - startTime, status: 'failed' };
    }
  }

  private async executeStep1(triangle: any, opportunity: ArbitrageOpportunity): Promise<OrderResult> {
    const symbol = `${triangle.base}_${triangle.quote}`;
    const side: 'SELL' | 'BUY' = 'SELL';
    console.log(`[STEP1] ${side} ${symbol}`);
    return this.placeOrder(symbol, side, this.config.orderSizeBase);
  }

  private async executeStep2(triangle: any, opportunity: ArbitrageOpportunity, step1Result: OrderResult): Promise<OrderResult> {
    const symbol = `${triangle.intermediate}_${triangle.quote}`;
    const side: 'BUY' | 'SELL' = 'BUY';
    const orderSize = step1Result.filledQuantity || this.config.orderSizeBase;
    console.log(`[STEP2] ${side} ${symbol}, size: ${orderSize}`);
    return this.placeOrder(symbol, side, orderSize);
  }

  private async executeStep3(triangle: any, opportunity: ArbitrageOpportunity, step2Result: OrderResult): Promise<OrderResult> {
    const symbol = `${triangle.base}_${triangle.intermediate}`;
    const side: 'BUY' | 'SELL' = 'BUY';
    const orderSize = step2Result.filledQuantity || this.config.orderSizeBase;
    console.log(`[STEP3] ${side} ${symbol}, size: ${orderSize}`);
    return this.placeOrder(symbol, side, orderSize);
  }

  private async placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<OrderResult> {
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        let price: number | undefined = undefined;
        let orderType: 'MARKET' | 'LIMIT' = this.config.useMarketOrders ? 'MARKET' : 'LIMIT';

        if (!this.config.useMarketOrders) {
          price = side === 'SELL'
            ? this.getBestBid(symbol) * (1 - this.config.aggressivePriceRate)
            : this.getBestAsk(symbol) * (1 + this.config.aggressivePriceRate);

          if (!price || price <= 0) {
            throw new Error(`Invalid price for ${symbol}: ${price}`);
          }
        }

        const order = await this.client.placeOrder({
          symbol: symbol.toUpperCase(),
          side,
          orderType,
          price: price?.toString(),
          quantity: quantity.toString(),
          timeInForce: this.config.useMarketOrders ? undefined : 'GTC'
        });

        console.log(`[ORDER] Placed: ${order.orderId} ${orderType} ${side} ${symbol} @ ${price || 'MARKET'} × ${quantity}`);

        if (this.config.useMarketOrders) {
          return {
            success: true,
            orderId: order.orderId,
            filledQuantity: quantity,
            executedPrice: price,
            timestamp: Date.now(),
            isMarketOrder: true
          };
        }

        this.activeOrders.set(order.orderId, {
          orderId: order.orderId,
          symbol,
          side,
          timestamp: Date.now()
        });

        const result = await this.waitForOrderExecution(order.orderId, symbol);
        this.activeOrders.delete(order.orderId);

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[RETRY] Attempt ${attempt}/${this.config.maxRetries} failed: ${errorMessage}`);

        if (attempt === this.config.maxRetries) {
          return { success: false, error: errorMessage, timestamp: Date.now() };
        }

        await this.sleep(this.config.retryDelayMs);
      }
    }

    return { success: false, error: 'Max retries exceeded', timestamp: Date.now() };
  }

  private async waitForOrderExecution(orderId: string, symbol: string): Promise<OrderResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.orderTimeoutMs) {
      try {
        const status = await this.client.getOrderStatus(orderId, symbol);

        if (status.status === 'FILLED') {
          console.log(`[ORDER] Filled: ${orderId}`);
          return {
            success: true,
            orderId,
            filledQuantity: parseFloat(status.executedQty),
            executedPrice: parseFloat(status.avgPrice),
            timestamp: Date.now()
          };
        }

        if (status.status === 'CANCELED' || status.status === 'REJECTED') {
          return { success: false, orderId, error: `Order ${status.status}`, timestamp: Date.now() };
        }

        await this.sleep(100);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[STATUS] Error checking order ${orderId}: ${errorMessage}`);
        await this.sleep(500);
      }
    }

    console.warn(`[TIMEOUT] Cancelling order ${orderId}`);
    await this.attemptCancel(orderId, symbol);

    return { success: false, orderId, error: 'Order timeout', timestamp: Date.now() };
  }

  private async attemptCancel(orderId: string, symbol: string): Promise<void> {
    try {
      await this.client.cancelOrder(orderId, symbol);
      console.log(`[CANCEL] Cancelled: ${orderId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CANCEL] Failed to cancel ${orderId}: ${errorMessage}`);
    }
  }

  private createReport(
    opportunity: ArbitrageOpportunity,
    orders: OrderResult[],
    startTime: number,
    status: 'executed' | 'partial' | 'failed' | 'cancelled'
  ): ExecutionReport {
    return {
      opportunity,
      orders,
      totalProfitUsdt: 0,
      totalFeesUsdt: 0,
      executionTimeMs: Date.now() - startTime,
      status
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  enable(): void {
    this.config.enabled = true;
    console.log('[EXEC] Trading ENABLED');
  }

  disable(): void {
    this.config.enabled = false;
    console.log('[EXEC] Trading DISABLED');
  }

  async cancelAllActiveOrders(): Promise<void> {
    console.log(`[EXEC] Cancelling ${this.activeOrders.size} active orders...`);
    const promises = [];
    for (const [orderId, order] of this.activeOrders) {
      promises.push(this.attemptCancel(orderId, order.symbol));
    }
    await Promise.all(promises);
    this.activeOrders.clear();
  }

  getActiveOrdersCount(): number {
    return this.activeOrders.size;
  }
}
