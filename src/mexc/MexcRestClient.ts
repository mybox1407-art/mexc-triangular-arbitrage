import { config } from '../config.js';

export class MexcRestClient {
  async getExchangeInfo(): Promise<unknown> {
    return this.get('/api/v3/exchangeInfo');
  }

  async getDepth(symbol: string, limit = 100): Promise<{
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  }> {
    return this.get(`/api/v3/depth?symbol=${symbol}&limit=${limit}`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${config.mexc.restUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MEXC REST ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }
}
