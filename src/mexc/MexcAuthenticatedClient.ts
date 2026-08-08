import { config } from '../config.js';
import crypto from 'crypto';

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';

  /**
   * Количество базового актива.
   *
   * Примеры:
   * - BUY QNTUSDT: количество QNT
   * - SELL QNTUSDC: количество QNT
   * - SELL USDCUSDT: количество USDC
   */
  quantity?: string;

  /**
   * Сумма в quote-активе.
   *
   * Для MARKET BUY QNTUSDT:
   * quoteOrderQty=10 означает потратить 10 USDT.
   */
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

  /**
   * Для MEXC query-order response это поле может быть
   * фактической ценой или исходной ценой ордера.
   */
  price?: string;

  /**
   * Может отсутствовать в REST response.
   * Если отсутствует, вычисляется как:
   * cummulativeQuoteQty / executedQty
   */
  avgPrice?: string;

  /**
   * Количество исполненного базового актива.
   */
  executedQty: string;

  /**
   * Фактически исполненная сумма в quote-активе.
   */
  cummulativeQuoteQty: string;

  time?: number;
  updateTime?: number;
}

export interface TradeFee {
  symbol: string;
  makerFeeRate: number;
  takerFeeRate: number;
}

type RequestValue = string | number;

export class MexcAuthenticatedClient {
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    if (!config.mexc.apiKey || !config.mexc.apiSecret) {
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
        ([key, value]) => [key, String(value)]
      )
    ).toString();
  }

  private signQueryString(
    queryString: string
  ): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private async readResponse(
    response: Response
  ): Promise<any> {
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${responseText}`
      );
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error(
        `Invalid JSON response from MEXC: ${responseText}`
      );
    }
  }

  private getHeaders(): HeadersInit {
    return {
      'X-MEXC-APIKEY': this.apiKey,
      'Content-Type': 'application/json'
    };
  }

  async getTradeFee(
    symbol: string
  ): Promise<TradeFee> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const timestamp = Date.now();

    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      timestamp,
      recvWindow: 5000
    };

    const queryString =
      this.buildQueryString(params);

    const signature =
      this.signQueryString(queryString);

    const url =
      `${config.mexc.restUrl}/api/v3/tradeFee?` +
      `${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const data =
      await this.readResponse(response);

    const feeData =
      Array.isArray(data.data)
        ? data.data[0]
        : data.data ?? data;

    const makerFeeRate = Number(
      feeData?.makerCommission ??
      feeData?.makerFeeRate ??
      config.trading.takerFeeRate
    );

    const takerFeeRate = Number(
      feeData?.takerCommission ??
      feeData?.takerFeeRate ??
      config.trading.takerFeeRate
    );

    return {
      symbol: normalizedSymbol,
      makerFeeRate: Number.isFinite(makerFeeRate)
        ? makerFeeRate
        : config.trading.takerFeeRate,
      takerFeeRate: Number.isFinite(takerFeeRate)
        ? takerFeeRate
        : config.trading.takerFeeRate
    };
  }

  async placeOrder(
    params: PlaceOrderParams
  ): Promise<NewOrderResponse> {
    const symbol =
      params.symbol.toUpperCase();

    if (
      params.quantity === undefined &&
      params.quoteOrderQty === undefined
    ) {
      throw new Error(
        'Either quantity or quoteOrderQty must be provided'
      );
    }

    if (
      params.quantity !== undefined &&
      params.quoteOrderQty !== undefined
    ) {
      throw new Error(
        'quantity and quoteOrderQty cannot be used together'
      );
    }

    if (
      params.orderType === 'LIMIT' &&
      !params.quantity
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

    const timestamp = Date.now();

    const requestBody: Record<
      string,
      RequestValue
    > = {
      symbol,
      side: params.side,
      type: params.orderType,
      timestamp,
      recvWindow: 5000
    };

    if (params.quantity !== undefined) {
      requestBody.quantity = params.quantity;
    }

    if (params.quoteOrderQty !== undefined) {
      requestBody.quoteOrderQty =
        params.quoteOrderQty;
    }

    if (params.price !== undefined) {
      requestBody.price = params.price;
    }

    if (params.timeInForce !== undefined) {
      requestBody.timeInForce =
        params.timeInForce;
    }

    const queryString =
      this.buildQueryString(requestBody);

    const signature =
      this.signQueryString(queryString);

    const url =
      `${config.mexc.restUrl}/api/v3/order?` +
      `${queryString}&signature=${signature}`;

    console.log(
      '[MEXC ORDER REQUEST]',
      JSON.stringify({
        symbol,
        side: params.side,
        type: params.orderType,
        quantity: params.quantity ?? null,
        quoteOrderQty:
          params.quoteOrderQty ?? null,
        price: params.price ?? null,
        timeInForce:
          params.timeInForce ?? null
      })
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders()
    });

    const data =
      await this.readResponse(response);

    return data as NewOrderResponse;
  }

  async getOrderStatus(
    orderId: string,
    symbol: string
  ): Promise<OrderStatus> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const timestamp = Date.now();

    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      orderId,
      timestamp,
      recvWindow: 5000
    };

    const queryString =
      this.buildQueryString(params);

    const signature =
      this.signQueryString(queryString);

    const url =
      `${config.mexc.restUrl}/api/v3/order?` +
      `${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const data =
      await this.readResponse(response);

    const status =
      data as OrderStatus;

    if (
      !status.executedQty ||
      !status.cummulativeQuoteQty
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

    return status;
  }

  async cancelOrder(
    orderId: string,
    symbol: string
  ): Promise<void> {
    const normalizedSymbol =
      symbol.toUpperCase();

    const timestamp = Date.now();

    const params: Record<string, RequestValue> = {
      symbol: normalizedSymbol,
      orderId,
      timestamp,
      recvWindow: 5000
    };

    const queryString =
      this.buildQueryString(params);

    const signature =
      this.signQueryString(queryString);

    const url =
      `${config.mexc.restUrl}/api/v3/order?` +
      `${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders()
    });

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
    const timestamp = Date.now();

    const params: Record<string, RequestValue> = {
      timestamp,
      recvWindow: 5000
    };

    const queryString =
      this.buildQueryString(params);

    const signature =
      this.signQueryString(queryString);

    const url =
      `${config.mexc.restUrl}/api/v3/account?` +
      `${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const data =
      await this.readResponse(response);

    if (!Array.isArray(data.balances)) {
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
          asset: String(balance.asset),
          free,
          locked,
          total: free + locked
        };
      });
  }
}
