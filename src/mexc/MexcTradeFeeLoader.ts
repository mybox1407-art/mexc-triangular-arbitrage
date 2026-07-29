import pino from 'pino';
import { config } from '../config.js';
import { MexcAuthenticatedClient } from './MexcAuthenticatedClient.js';

const REQUEST_DELAY_MS = 1_100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MexcTradeFeeLoader {
  constructor(
    private readonly client: MexcAuthenticatedClient,
    private readonly logger: pino.Logger
  ) {}

  async loadTakerFees(symbols: string): Promise<Map<string, number>>;
  async loadTakerFees(symbols: string[]): Promise<Map<string, number>>;
  async loadTakerFees(
    symbols: string | string[]
  ): Promise<Map<string, number>> {
    const uniqueSymbols = [
      ...new Set(
        (Array.isArray(symbols) ? symbols : [symbols]).map((symbol) =>
          symbol.toUpperCase()
        )
      )
    ];

    const fees = new Map<string, number>();

    for (const symbol of uniqueSymbols) {
      try {
        const fee = await this.client.getTradeFee(symbol);

        fees.set(symbol, fee.takerFeeRate);

        this.logger.info(
          {
            symbol,
            makerFeeRate: fee.makerFeeRate,
            takerFeeRate: fee.takerFeeRate
          },
          'Loaded MEXC account trade fee'
        );
      } catch (error) {
        fees.set(symbol, config.trading.takerFeeRate);

        this.logger.warn(
          {
            err: error,
            symbol,
            fallbackTakerFeeRate: config.trading.takerFeeRate
          },
          'Could not load MEXC account fee; using fallback fee'
        );
      }

      await sleep(REQUEST_DELAY_MS);
    }

    return fees;
  }
}
