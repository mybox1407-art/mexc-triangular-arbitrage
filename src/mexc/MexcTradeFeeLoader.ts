import pino from 'pino';
import { config } from '../config.js';
import { MexcAuthenticatedClient } from './MexcAuthenticatedClient.js';

const REQUEST_DELAY_MS = 1_100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error.message.includes('code":700007') ||
      error.message.includes('No permission to access the endpoint')
    )
  );
}

export class MexcTradeFeeLoader {
  constructor(
    private readonly client: MexcAuthenticatedClient,
    private readonly logger: pino.Logger
  ) {}

  async loadTakerFees(symbols: string[]): Promise<Map<string, number>> {
    const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    const fees = new Map<string, number>();

    for (const symbol of uniqueSymbols) {
      try {
        const fee = await this.client.getTradeFee(symbol);
        fees.set(symbol, fee.takerFeeRate);
        this.logger.info({
          symbol,
          makerFeeRate: fee.makerFeeRate,
          takerFeeRate: fee.takerFeeRate
        }, 'Loaded MEXC account trade fee');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isPermissionError(error)) {
          this.logger.error({
            err: error,
            symbol,
            fallbackTakerFeeRate: config.trading.takerFeeRate,
            errorMessage
          }, 'MEXC API key lacks SPOT_ACCOUNT_READ; using fallback fee for all symbols');

          for (const remainingSymbol of uniqueSymbols) {
            fees.set(remainingSymbol, config.trading.takerFeeRate);
          }
          return fees;
        }

        fees.set(symbol, config.trading.takerFeeRate);
        this.logger.warn({
          err: error,
          symbol,
          fallbackTakerFeeRate: config.trading.takerFeeRate,
          errorMessage
        }, 'Could not load MEXC account fee; using fallback fee');
      }

      await sleep(REQUEST_DELAY_MS);
    }

    return fees;
  }
}
