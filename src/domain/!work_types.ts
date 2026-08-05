export type Side = 'BUY' | 'SELL';

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: 'ONLINE' | 'PAUSE' | 'OFFLINE';
  isSpotTradingAllowed: boolean;
  baseSizePrecision: number;
  quoteAmountPrecision: number;
  quoteAmountPrecisionMarket: number;
  minQuoteAmount?: number;
  minQuoteAmountMarket?: number;
  makerCommission?: number;
  takerCommission?: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
  updatedAt: number;
  ready: boolean;
}

export interface TriangleLeg {
  symbol: string;
  fromAsset: string;
  toAsset: string;
  side: Side;
}

export interface Triangle {
  id: string;
  startAsset: string;
  middleAsset1: string;
  middleAsset2: string;
  legs: [TriangleLeg, TriangleLeg, TriangleLeg];
}

export interface SimulatedLeg {
  symbol: string;
  side: Side;
  fromAsset: string;
  toAsset: string;
  inputAmount: number;
  outputAmount: number;
  vwap: number;
  feePaidInOutput: number;
  levelsUsed: number;
}

export interface Opportunity {
  triangleId: string;
  startAsset: string;
  startAmount: number;
  finalAmount: number;

  // ROI до учёта комиссий (чистый VWAP, ideal).
  grossRoiBeforeFees: number;

  // ROI после комиссий, до safety buffer.
  grossRoiAfterFees: number;

  // ROI после комиссий + safety buffer.
  netRoi: number;

  // Суммарная комиссия как доля от startAmount.
  totalFeeRate: number;

  // Суммарная комиссия в единицах стартового ассета (USDC).
  totalFeeInStartAsset: number;

  expectedProfit: number;
  legs: [SimulatedLeg, SimulatedLeg, SimulatedLeg];
  detectedAt: Date;

  // Для совместимости с ArbitrageRepository (alias на grossRoiAfterFees).
  grossRoi: number;
}
