import { createHmac } from 'node:crypto';
import { config } from '../config.js';

type MexcTradeFeeResponse = {
  code: number;
  msg: string;
  data?:
    | {
        makerCommission: number | string;
        takerCommission: number | string;
        rpiTakerCommission?: number | string | null;
      }
    | Array<{
        symbol: string;
        makerCommission: number | string;
        takerCommission: number | string;
        rpiTakerCommission?: number | string | null;
      }>;
};

export type SymbolTradeFee = {
  makerFeeRate: number;
  takerFeeRate: number;
};

export class MexcAuthenticatedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(
    apiKey = config.mexc.apiKey,
    apiSecret = config.mexc.apiSecret
  ) {
    if (!apiKey || !apiSecret) {
      throw new Error(
        'MEXC_API_KEY and MEXC_API_SECRET are required to load actual symbol fees'
      );
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async getTradeFee(symbol?: string): Promise<Record<string, SymbolTradeFee>> {
    const params = new URLSearchParams({
      recvWindow: '5000',
      timestamp: String(Date.now())
    });

    // Если symbol не указан — запрашиваем ВСЕ комиссии (batch)
    if (symbol) {
      params.set('symbol', symbol.toUpperCase());
    }

    const signature = createHmac('sha256', this.apiSecret)
      .update(params.toString())
      .digest('hex');

    params.set('signature', signature);

    const response = await fetch(
      `${config.mexc.restUrl}/api/v3/tradeFee?${params.toString()}`,
      {
        headers: {
          'X-MEXC-APIKEY': this.apiKey
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `MEXC tradeFee request failed${symbol ? ` for ${symbol}` : ''}: ` +
          `${response.status} ${response.statusText}; ${text}`
      );
    }

    const payload = (await response.json()) as MexcTradeFeeResponse;

    if (payload.code !== 0 || !payload.data) {
      throw new Error(
        `MEXC tradeFee response failed${symbol ? ` for ${symbol}` : ''}: ` +
          `${payload.code} ${payload.msg}`
      );
    }

    // Если запрошен конкретный символ — возвращаем один объект
    if (symbol && !Array.isArray(payload.data)) {
      const makerFeeRate = Number(payload.data.makerCommission);
      const takerFeeRate = Number(payload.data.takerCommission);

      if (
        !Number.isFinite(makerFeeRate) ||
        makerFeeRate < 0 ||
        !Number.isFinite(takerFeeRate) ||
        takerFeeRate < 0
      ) {
        throw new Error(
          `Invalid MEXC fee response for ${symbol}: ` +
            `${JSON.stringify(payload.data)}`
        );
      }

      return {
        [symbol.toUpperCase()]: {
          makerFeeRate,
          takerFeeRate
        }
      };
    }

    // Если запрошены все — возвращаем Record
    const result: Record<string, SymbolTradeFee> = {};

    if (Array.isArray(payload.data)) {
      for (const item of payload.data) {
        const symbol = item.symbol.toUpperCase();
        const makerFeeRate = Number(item.makerCommission);
        const takerFeeRate = Number(item.takerCommission);

        if (
          !Number.isFinite(makerFeeRate) ||
          makerFeeRate < 0 ||
          !Number.isFinite(takerFeeRate) ||
          takerFeeRate < 0
        ) {
          throw new Error(
            `Invalid MEXC fee response for ${symbol}: ` +
              `${JSON.stringify(item)}`
          );
        }

        result[symbol] = {
          makerFeeRate,
          takerFeeRate
        };
      }
    }

    return result;
  }
}
