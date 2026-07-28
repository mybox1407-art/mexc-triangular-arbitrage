import { config } from '../config.js';

export class MexcRestClient {
  private readonly maxRetries = 3;
  private readonly retryDelay = 2000;

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

  private async get<T>(path: string, retryCount = 0): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд вместо 5

    try {
      const response = await fetch(`${config.mexc.restUrl}${path}`, {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'MexcArbitrageBot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`MEXC REST ${response.status}: ${body}`);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      clearTimeout(timeoutId);

      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * (retryCount + 1);
        console.warn(`MEXC request failed, retry ${retryCount + 1}/${this.maxRetries} in ${delay}ms:`, error instanceof Error ? error.message : error);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.get<T>(path, retryCount + 1);
      }

      throw error;
    }
  }
}
