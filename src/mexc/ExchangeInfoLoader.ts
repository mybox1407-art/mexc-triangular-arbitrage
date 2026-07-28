import type { SymbolInfo } from '../domain/types.js';
import { MexcRestClient } from './MexcRestClient.js';

interface ExchangeInfoSymbol {
  symbol: string;
  status: number;
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
      return (
        item.status === 1 &&
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

      // Это шаг количества/суммы, а не "число знаков".
      // Пока сохраняем значение как есть; нормализацию добавим отдельно.
      baseSizePrecision: toNumber(item.baseSizePrecision, 0),
      quoteAmountPrecision: toNumber(item.quoteAmountPrecision, 0),
      quoteAmountPrecisionMarket: toNumber(item.quoteAmountPrecisionMarket, 0),

      minQuoteAmount: toNumber(item.minQuoteAmount, 0) || undefined,
      minQuoteAmountMarket: toNumber(item.minQuoteAmountMarket, 0) || undefined,

      makerCommission: toNumber(item.makerCommission, 0),
      takerCommission: toNumber(item.takerCommission, 0)
    }));
  }
}
