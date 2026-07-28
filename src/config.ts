import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function numberEnv(name: string, fallback?: string): number {
  const value = Number(env(name, fallback));
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  logLevel: env('LOG_LEVEL', 'info'),

  mexc: {
    restUrl: env('MEXC_REST_URL', 'https://api.mexc.com'),
    wsUrl: env('MEXC_WS_URL', 'wss://wbs-api.mexc.com/ws'),
    apiKey: process.env.MEXC_API_KEY,
    apiSecret: process.env.MEXC_API_SECRET
  },

  trading: {
    liveTrading: env('LIVE_TRADING', 'false') === 'true',
    startAsset: env('START_ASSET', 'USDT').toUpperCase(),
    startNotional: numberEnv('START_NOTIONAL', '25'),
    maxNotionalPerCycle: numberEnv('MAX_NOTIONAL_PER_CYCLE', '25'),
    minNetRoi: numberEnv('MIN_NET_ROI', '0.003'),
    takerFeeRate: numberEnv('TAKER_FEE_RATE', '0.001'),
    safetyBufferRate: numberEnv('SAFETY_BUFFER_RATE', '0.0005')
  },

  databaseUrl: env('DATABASE_URL')
};
