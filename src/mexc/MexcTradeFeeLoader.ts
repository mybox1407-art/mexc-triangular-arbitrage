import pino from 'pino';
import { config } from '../config.js';
import { MexcAuthenticatedClient } from './MexcAuthenticatedClient.js';

const ZERO_FEE_EPSILON = 1e-12;

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
    const uniqueSymbols = [
      ...new Set(symbols.map((symbol) => symbol.toUpperCase()))
    ];

    const fees = new Map<string, number>();

    try {
      this.logger.info(
        {
          totalSymbols: uniqueSymbols.length,
          method: 'batch'
        },
        'Loading ALL commission rates from MEXC API (batch mode)'
      );

      // Запрашиваем ВСЕ комиссии сразу (без symbol параметра) — 1 запрос вместо N
      const allFees = await this.client.getTradeFee();

      // Фильтруем только нужные нам символы
      for (const [symbol, feeData] of Object.entries(allFees)) {
        const normalizedSymbol = symbol.toUpperCase();

        if (uniqueSymbols.includes(normalizedSymbol)) {
          const takerFee = Number(feeData.takerFeeRate) || config.trading.takerFeeRate;
          const makerFee = Number(feeData.makerFeeRate) || 0;

          fees.set(normalizedSymbol, takerFee);

          this.logger.debug(
            {
              symbol: normalizedSymbol,
              makerFeeRate: makerFee,
              takerFeeRate: takerFee
            },
            'Loaded MEXC account trade fee'
          );
        }
      }

      // Анализируем тип аккаунта
      const avgTakerFee = [...fees.values()]
        .reduce((sum, fee) => sum + fee, 0) / Math.max(fees.size, 1);

      const hasZeroFees = [...fees.values()].some(fee => Math.abs(fee) <= ZERO_FEE_EPSILON);
      const isApiUser = avgTakerFee >= 0.0005; // 0.05% threshold

      this.logger.info(
        {
          totalSymbols: fees.size,
          avgTakerFee,
          avgTakerFeePercent: (avgTakerFee * 100).toFixed(4) + '%',
          expectedTakerFee: config.trading.takerFeeRate,
          expectedTakerFeePercent: (config.trading.takerFeeRate * 100).toFixed(2) + '%',
          hasZeroFees,
          isApiUser,
          message: isApiUser
            ? '⚠️ API USER: 0.05% taker fee on ALL pairs (zero-fee campaign excludes API users)'
            : '✅ Zero-fee eligible: some pairs have 0% commission'
        },
        'MEXC fee structure analysis complete'
      );

      return fees;
    } catch (error) {
      if (isPermissionError(error)) {
        this.logger.error(
          {
            err: error,
            fallbackTakerFeeRate: config.trading.takerFeeRate,
            fallbackTakerFeePercent: (config.trading.takerFeeRate * 100).toFixed(2) + '%'
          },
          'MEXC API key lacks SPOT_ACCOUNT_READ; using fallback fee for all symbols'
        );

        for (const symbol of uniqueSymbols) {
          fees.set(symbol, config.trading.takerFeeRate);
        }

        return fees;
      }

      this.logger.warn(
        {
          err: error,
          fallbackTakerFeeRate: config.trading.takerFeeRate,
          fallbackTakerFeePercent: (config.trading.takerFeeRate * 100).toFixed(2) + '%'
        },
        'Could not load MEXC account fee via API; using fallback fee'
      );
    }

    // Fallback
    for (const symbol of uniqueSymbols) {
      fees.set(symbol, config.trading.takerFeeRate);
    }

    return fees;
  }
}
