import { config } from '../config.js';
import crypto from 'crypto';

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity?: string;
  quoteOrderQty?: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface NewOrderResponse {
  symbol: string;
  orderId: string;
  orderListId?: number;
  clientOrderId?: string;
  price?: string;
  origQty?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  type?: string;
  side?: string;
  transactTime?: number;
}

export interface OrderStatus {
  orderId: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  price?: string;
  avgPrice?: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  cumulativeQuoteQty?: string;
  time?: number;
  updateTime?: number;
}

export interface AccountTrade {
  symbol: string;
  id: string;
  orderId: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  isBestMatch?: boolean;
  isSelfTrade?: boolean;
  clientOrderId?: string | null;
}

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

type RequestValue = string | number;

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor() {
    if (
      !config.mexc.apiKey ||
      !config.mexc.apiSecret
    ) {
      throw new Error(
        'MEXC API credentials not configured'
      );
    }

    this.apiKey = config.mexc.apiKey;
    this.apiSecret = config.mexc.apiSecret;
  }

  private buildQueryString(
    params: Record<string, RequestValue>
  ): string {
    return new URLSearchParams(
      Object.entries(params).map(
        ([key, value]) => [
          key,
          String(value)
        ]
      )
    ).toString();
  }

  private signQueryString(
    queryString: string
  ): string {
    return crypto
      .createHmac(
        'sha256',
        this.apiSecret
      )
      .update(queryString)
      .digest('hex');
  }

  private headers(): HeadersInit {
    return {
      'X-MEXC-APIKEY': this.apiKey,
      'Content-Type': 'application/json'
    };
  }

  private async readResponse(
    response: Response
  ): Promise<any> {
    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${text}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response from MEXC: ${text}`
      );
    }
  }

  private buildSignedUrl(
    endpoint: string,
    params: Record<string, RequestValue>
  ): string {
    const queryString =
      this.buildQueryString(params);

    const signature =
      this.signQueryString(queryString);

    return (
      `${config.mexc.restUrl}${endpoint}?` +
      `${queryString}&signature=${signature}`
    );
  }

  async getTradeFee(
    symbol: string
  ): Promise<TradeFee> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const params: Record<
      string,
      RequestValue
    > = {
      symbol: normalizedSymbol,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/tradeFee',
        params
      ),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data =
      await this.readResponse(response);

    const feeData =
      Array.isArray(data.data)
        ? data.data[0]
        : data.data ?? data;

    const makerFeeRate =
      Number(
        feeData?.makerCommission ??
        feeData?.makerFeeRate ??
        config.trading.takerFeeRate
      );

    const takerFeeRate =
      Number(
        feeData?.takerCommission ??
        feeData?.takerFeeRate ??
        config.trading.takerFeeRate
      );

    return {
      symbol: normalizedSymbol,

      makerFeeRate:
        Number.isFinite(makerFeeRate)
          ? makerFeeRate
          : config.trading.takerFeeRate,

      takerFeeRate:
        Number.isFinite(takerFeeRate)
          ? takerFeeRate
          : config.trading.takerFeeRate
    };
  }

  async placeOrder(
    params: PlaceOrderParams
  ): Promise<NewOrderResponse> {
    const symbol =
      params.symbol.toUpperCase();

    const hasQuantity =
      params.quantity !== undefined;

    const hasQuoteOrderQty =
      params.quoteOrderQty !== undefined;

    if (!hasQuantity && !hasQuoteOrderQty) {
      throw new Error(
        'Either quantity or quoteOrderQty must be provided'
      );
    }

    if (hasQuantity && hasQuoteOrderQty) {
      throw new Error(
        'quantity and quoteOrderQty cannot be used together'
      );
    }

    if (
      params.orderType === 'LIMIT' &&
      !hasQuantity
    ) {
      throw new Error(
        'LIMIT order requires quantity'
      );
    }

    if (
      params.orderType === 'LIMIT' &&
      !params.price
    ) {
      throw new Error(
        'LIMIT order requires price'
      );
    }

    if (
      params.orderType === 'MARKET' &&
      params.price !== undefined
    ) {
      throw new Error(
        'MARKET order must not contain price'
      );
    }

    const requestBody: Record<
      string,
      RequestValue
    > = {
      symbol,
      side: params.side,
      type: params.orderType,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    if (hasQuantity) {
      requestBody.quantity =
        params.quantity!;
    }

    if (hasQuoteOrderQty) {
      requestBody.quoteOrderQty =
        params.quoteOrderQty!;
    }

    if (params.price !== undefined) {
      requestBody.price =
        params.price;
    }

    if (params.timeInForce !== undefined) {
      requestBody.timeInForce =
        params.timeInForce;
    }

    console.log(
      '[MEXC ORDER REQUEST]',
      JSON.stringify({
        symbol,
        side: params.side,
        type: params.orderType,
        quantity:
          params.quantity ?? null,
        quoteOrderQty:
          params.quoteOrderQty ?? null,
        price:
          params.price ?? null,
        timeInForce:
          params.timeInForce ?? null
      })
    );

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/order',
        requestBody
      ),
      {
        method: 'POST',
        headers: this.headers()
      }
    );

    return await this.readResponse(
      response
    );
  }

  async getOrderStatus(
    orderId: string,
    symbol: string
  ): Promise<OrderStatus> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const params: Record<
      string,
      RequestValue
    > = {
      symbol: normalizedSymbol,
      orderId,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/order',
        params
      ),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data =
      await this.readResponse(response);

    if (
      data.executedQty === undefined ||
      (
        data.cummulativeQuoteQty ===
        undefined &&
        data.cumulativeQuoteQty ===
        undefined
      )
    ) {
      console.warn(
        '[MEXC ORDER STATUS] Missing execution fields',
        JSON.stringify({
          orderId,
          symbol: normalizedSymbol,
          status: data
        })
      );
    }

    return data as OrderStatus;
  }

  async getMyTrades(
    symbol: string,
    orderId: string
  ): Promise<AccountTrade[]> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const params: Record<
      string,
      RequestValue
    > = {
      symbol: normalizedSymbol,
      orderId,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/myTrades',
        params
      ),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data =
      await this.readResponse(response);

    if (!Array.isArray(data)) {
      throw new Error(
        `Invalid myTrades response for ${normalizedSymbol}`
      );
    }

    return data as AccountTrade[];
  }

  async cancelOrder(
    orderId: string,
    symbol: string
  ): Promise<void> {
    const params: Record<
      string,
      RequestValue
    > = {
      symbol: symbol.toUpperCase(),
      orderId,
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/order',
        params
      ),
      {
        method: 'DELETE',
        headers: this.headers()
      }
    );

    await this.readResponse(response);
  }

  async getAccountBalances(): Promise<
    Array<{
      asset: string;
      free: number;
      locked: number;
      total: number;
    }>
  > {
    const params: Record<
      string,
      RequestValue
    > = {
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const response = await fetch(
      this.buildSignedUrl(
        '/api/v3/account',
        params
      ),
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    const data =
      await this.readResponse(response);

    if (
      !Array.isArray(data.balances)
    ) {
      throw new Error(
        'Invalid balances response from MEXC'
      );
    }

    return data.balances
      .filter((balance: any) => {
        const free =
          Number(balance.free ?? 0);

        const locked =
          Number(balance.locked ?? 0);

        return free > 0 || locked > 0;
      })
      .map((balance: any) => {
        const free =
          Number(balance.free ?? 0);

        const locked =
          Number(balance.locked ?? 0);

        return {
          asset: String(
            balance.asset
          ),
          free,
          locked,
          total: free + locked
        };
      });
  }
}
