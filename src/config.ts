import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function numberEnv(name: string, fallback?: string): number {
  const value = Number(env(name, fallback));

  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return value;
}

function rateEnv(name: string, fallback: string): number {
  const value = numberEnv(name, fallback);

  if (value < 0 || value >= 1) {
    throw new Error(
      `Environment variable ${name} must be a rate from 0 (inclusive) to 1 (exclusive)`
    );
  }

  return value;
}

function positiveNumberEnv(name: string, fallback: string): number {
  const value = numberEnv(name, fallback);

  if (value <= 0) {
    throw new Error(`Environment variable ${name} must be greater than 0`);
  }

  return value;
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  logLevel: env('LOG_LEVEL', 'info'),

  // Путь внутри контейнера для CSV с прошедшими paper-сигналами.
  csvOpportunitiesPath: env(
    'CSV_OPPORTUNITIES_PATH',
    '/app/data/paper-opportunities.csv'
  ),

  // CSV со лучшим маршрутом за каждый 10-секундный интервал.
  csvBestRoutesPath: env(
    'CSV_BEST_ROUTES_PATH',
    '/app/data/paper-best-routes.csv'
  ),

  mexc: {
    restUrl: env('MEXC_REST_URL', 'https://api.mexc.com'),
    wsUrl: env('MEXC_WS_URL', 'wss://wbs-api.mexc.com/ws'),
    apiKey: process.env.MEXC_API_KEY,
    apiSecret: process.env.MEXC_API_SECRET
  },

  trading: {
    liveTrading: env('LIVE_TRADING', 'false') === 'true',
    startAsset: env('START_ASSET', 'USDT').toUpperCase(),

    // Только для paper-сканирования: объём одного виртуального цикла.
    startNotional: positiveNumberEnv('START_NOTIONAL', '10'),

    // Оставляем лимит отдельно от startNotional для будущего live-режима.
    maxNotionalPerCycle: positiveNumberEnv(
      'MAX_NOTIONAL_PER_CYCLE',
      '10'
    ),

    // Порог по netRoi (если где-то ещё нужен).
    minNetRoi: rateEnv('MIN_NET_ROI', '0.0003'),

    // Новый порог: gross ROI после комиссий (до safety buffer).
    // По умолчанию 0.3% = 0.003.
    minGrossRoiAfterFees: rateEnv(
      'MIN_GROSS_ROI_AFTER_FEES',
      '0.003'
    ),

    // Standard MEXC spot taker fee: 0.05%.
    takerFeeRate: rateEnv('TAKER_FEE_RATE', '0.0005'),

    // Резерв на задержку, движение цены и неучтённое проскальзывание: 0.02%.
    safetyBufferRate: rateEnv('SAFETY_BUFFER_RATE', '0.0002')
  },

  databaseUrl: env('DATABASE_URL')
};
