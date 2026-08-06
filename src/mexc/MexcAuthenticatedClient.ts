import { config } from '../config.js';
import crypto from 'crypto';

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderStatus {
  orderId: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  price: string;
  avgPrice: string;
  executedQty: string;
  cummativeQuoteQty: string;
  time: number;
}

export class MexcAuthenticatedClient {
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    if (!config.mexc.apiKey || !config.mexc.apiSecret) {
      throw new Error('MEXC API credentials not configured');
    }

    this.apiKey = config.mexc.apiKey;
    this.apiSecret = config.mexc.apiSecret;
  }

  private signRequest(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderStatus> {
    const timestamp = Date.now();
    const requestBody: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.orderType,
      quantity: params.quantity,
      timestamp,
      recvWindow: 5000
    };

    if (params.price) {
      requestBody.price = params.price;
    }

    if (params.timeInForce) {
      requestBody.timeInForce = params.timeInForce;
    }

    const signature = this.signRequest(requestBody);

    const url = `${config.mexc.restUrl}/api/v3/order`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MEXC-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...requestBody,
        signature
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    return await response.json();
  }

  async getOrderStatus(orderId: string, symbol: string): Promise<OrderStatus> {
    const timestamp = Date.now();
    const params = {
      symbol,
      orderId,
      timestamp,
      recvWindow: 5000
    };

    const signature = this.signRequest(params);

    const url = `${config.mexc.restUrl}/api/v3/order?symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=5000&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    return await response.json();
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    const timestamp = Date.now();
    const params = {
      symbol,
      orderId,
      timestamp,
      recvWindow: 5000
    };

    const signature = this.signRequest(params);

    const url = `${config.mexc.restUrl}/api/v3/order`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'X-MEXC-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...params,
        signature
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }
  }

  async getAccountBalances(): Promise<Array<{
    asset: string;
    free: number;
    locked: number;
    total: number;
  }>> {
    const timestamp = Date.now();
    const params = { timestamp };
    const signature = this.signRequest(params);

    const url = `${config.mexc.restUrl}/api/v3/account?timestamp=${timestamp}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const data = await response.json();
    
    return data.balances
      .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b: any) => ({
        asset: b.asset,
        free: parseFloat(b.free),
        locked: parseFloat(b.locked),
        total: parseFloat(b.free) + parseFloat(b.locked)
      }));
  }
}
