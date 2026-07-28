import type { SymbolInfo } from '../domain/types.js';
import { MexcRestClient } from './MexcRestClient.js';

interface ExchangeInfoSymbol {
  symbol: string;
  status: string | number;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed: boolean;

  baseSizePrecision?: string | number;
  quoteAmountPrecision?: string | number;
  quoteAmountPrecisionMarket?: string | number;

  minQuoteAmount?: string | number;
  minQuoteAmountMarket?: string | number;

  makerCommission?: string | number;
  takerCommission?: string | number;
}

interface ExchangeInfoResponse {
  symbols: ExchangeInfoSymbol[];
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class ExchangeInfoLoader {
  constructor(private readonly rest: MexcRestClient) {}

  async loadSpotSymbols(): Promise<SymbolInfo[]> {
    const raw = await this.rest.getExchangeInfo() as ExchangeInfoResponse;

    if (!Array.isArray(raw.symbols)) {
      throw new Error('MEXC exchangeInfo has no symbols array');
    }

    const active = raw.symbols.filter((item) => {
      const statusOnline = String(item.status) === '1';

      return (
        statusOnline &&
        item.isSpotTradingAllowed === true &&
        Boolean(item.symbol) &&
        Boolean(item.baseAsset) &&
        Boolean(item.quoteAsset)
      );
    });

    console.log(JSON.stringify({
      msg: 'MEXC exchangeInfo parsed',
      totalSymbols: raw.symbols.length,
      activeSpotSymbols: active.length,
      sample: active.slice(0, 5).map((item) => ({
        symbol: item.symbol,
        status: item.status,
        baseAsset: item.baseAsset,
        quoteAsset: item.quoteAsset,
        isSpotTradingAllowed: item.isSpotTradingAllowed
      }))
    }));

    return active.map((item) => ({
      symbol: item.symbol.toUpperCase(),
      baseAsset: item.baseAsset.toUpperCase(),
      quoteAsset: item.quoteAsset.toUpperCase(),
      status: 'ONLINE',
      isSpotTradingAllowed: true,

      baseSizePrecision: toNumber(item.baseSizePrecision),
      quoteAmountPrecision: toNumber(item.quoteAmountPrecision),
      quoteAmountPrecisionMarket: toNumber(item.quoteAmountPrecisionMarket),

      minQuoteAmount: toNumber(item.minQuoteAmount) || undefined,
      minQuoteAmountMarket: toNumber(item.minQuoteAmountMarket) || undefined,

      makerCommission: toNumber(item.makerCommission),
      takerCommission: toNumber(item.takerCommission)
    }));
  }
}
