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
  grossRoi: number;
  netRoi: number;
  expectedProfit: number;
  legs: [SimulatedLeg, SimulatedLeg, SimulatedLeg];
  detectedAt: Date;
}
