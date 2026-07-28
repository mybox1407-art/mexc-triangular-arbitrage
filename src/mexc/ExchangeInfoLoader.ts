import type { SymbolInfo } from '../domain/types.js';
import { MexcRestClient } from './MexcRestClient.js';

interface ExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: number;
    isSpotTradingAllowed: boolean;
    baseSizePrecision: string;
    quoteAmountPrecision: string;
    quoteAmountPrecisionMarket: string;
    minQuoteAmount?: string;
    minQuoteAmountMarket?: string;
    makerCommission?: string;
    takerCommission?: string;
  }>;
}

export class ExchangeInfoLoader {
  constructor(private readonly rest: MexcRestClient) {}

  async loadSpotSymbols(): Promise<SymbolInfo[]> {
    const raw = await this.rest.getExchangeInfo() as ExchangeInfoResponse;

    return raw.symbols
      .filter((item) => item.status === 1 && item.isSpotTradingAllowed)
      .map((item) => ({
        symbol: item.symbol,
        baseAsset: item.baseAsset,
        quoteAsset: item.quoteAsset,
        status: 'ONLINE',
        isSpotTradingAllowed: item.isSpotTradingAllowed,
        baseSizePrecision: Number(item.baseSizePrecision),
        quoteAmountPrecision: Number(item.quoteAmountPrecision),
        quoteAmountPrecisionMarket: Number(item.quoteAmountPrecisionMarket),
        minQuoteAmount: item.minQuoteAmount ? Number(item.minQuoteAmount) : undefined,
        minQuoteAmountMarket: item.minQuoteAmountMarket
          ? Number(item.minQuoteAmountMarket)
          : undefined,
        makerCommission: item.makerCommission ? Number(item.makerCommission) : undefined,
        takerCommission: item.takerCommission ? Number(item.takerCommission) : undefined
      }));
  }
}
