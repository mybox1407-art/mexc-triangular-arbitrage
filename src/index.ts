import pino from 'pino';
import { config } from './config.js';
import { ConfigValidator } from './utils/ConfigValidator.js';
import { OrderBook } from './domain/orderBook.js';
import { ExchangeInfoLoader } from './mexc/ExchangeInfoLoader.js';
import { MexcAuthenticatedClient } from './mexc/MexcAuthenticatedClient.js';
import { MexcPublicWs } from './mexc/MexcPublicWs.js';
import { MexcRestClient } from './mexc/MexcRestClient.js';
import { MexcTradeFeeLoader } from './mexc/MexcTradeFeeLoader.js';
import { ArbitrageCalculator } from './services/ArbitrageCalculator.js';
import { CsvOpportunityWriter } from './services/CsvOpportunityWriter.js';
import { CsvBestRouteWriter } from './services/CsvBestRouteWriter.js';
import { OpportunityService } from './services/OpportunityService.js';
import { PerformanceLogWriter } from './services/PerformanceLogWriter.js';
import { TelegramNotifier } from './services/TelegramNotifier.js';
import { TriangleBuilder } from './services/TriangleBuilder.js';
import {
  OrderExecutionService,
  OrderExecutionConfig,
  SymbolFilter
} from './services/OrderExecutionService.js';

const ALLOWED_ASSETS = new Set([
  'USDC', 'USDT', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE',
  'LTC', 'BCH', 'TRX', 'ADA', 'LINK', 'AVAX', 'DOT',
  'TON', 'BNB', 'SUI', 'APT', 'NEAR', 'ATOM', 'FIL',
  'ARB', 'OP', 'AAVE', 'UNI', 'ETC', 'XLM', 'HBAR',
  'ICP', 'INJ', 'SEI', 'TIA', 'WLD', 'CRV', 'MKR',
  'MATIC', 'POL', 'PEPE', 'SHIB', 'FLOKI', 'WIF',
  'BONK', 'PENGU', 'JUP', 'KAS', 'RUNE', 'BOME',
  'NOT', 'ORDI', 'PNUT', 'POPCAT', 'MEW', 'CHILLGUY',
  'TAO', 'FET', 'GOAT', 'MYRO', 'NEIRO', 'THE', 'PONKE',
  'TRUMP', 'MELANIA', 'PI', 'SAND', 'MANA', 'GRT',
  'FTM', 'ALGO', 'VET', 'THETA', 'EGLD', 'AXS', 'FLOW',
  'XTZ', 'KAVA', 'IOTA', 'ZIL', 'ICX', 'ENJ', 'CHZ',
  'BAT', 'ZRX', 'LRC', 'CELO', 'ONE', 'QTUM', 'RVN',
  'DASH', 'ZEC', 'XMR', 'SC', 'DGB', 'ONT', 'GALA',
  'IMX', 'LDO', 'RPL', 'GMX', 'RNDR', 'AGIX', 'OCEAN',
  'SXP', 'CFX', 'BEAM', 'STRK', 'PYTH', 'TNSR', 'JTO',
  'SOMI', 'AKT', 'RENDER', 'VRA', 'RLC', 'TRAC',
  'VIRTUAL', 'OLAS', 'KITE', 'NOS', 'PHB', 'U2U', 'CTX',
  'QNT', 'MANTRA', 'REZ', 'DYM', 'METIS', 'PENDLE',
  'PIXEL', 'PORTAL', 'ALT', 'MANTA', 'AEVO', 'ETHFI',
  'ENA', 'SLERF', 'OMNI', 'REI', 'XAI', 'METAFI',
  'RATS', '1000SATS', 'SATS', 'DEGEN', 'ACE', 'NFP',
  'AI', 'BABYDOGE', 'LEASH', 'MX'
]);

const MAX_TRIANGLES =
  Number.POSITIVE_INFINITY;

const MAX_PAID_LEGS = 3;
const SNAPSHOT_DELAY_MS = 300;
const HEALTH_CHECK_INTERVAL_MS = 120_000;
const STALE_BOOK_AFTER_MS = 5_000;
const ZERO_FEE_EPSILON = 1e-12;

const logger =
  pino({
    level: config.logLevel
  });

const rest =
  new MexcRestClient();

const csvWriter =
  new CsvOpportunityWriter(
    config.csvOpportunitiesPath
  );

const csvBestRouteWriter =
  new CsvBestRouteWriter(
    config.csvBestRoutesPath
  );

const performanceLogWriter =
  new PerformanceLogWriter(
    config.performanceLogPath
  );

const telegramNotifier =
  new TelegramNotifier();

const sleep = (
  milliseconds: number
): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );

function extractSymbolFilters(
  exchangeInfo: any
): Map<string, SymbolFilter> {
  const result =
    new Map<string, SymbolFilter>();

  const symbols: any[] =
    Array.isArray(exchangeInfo?.symbols)
      ? exchangeInfo.symbols
      : [];

  for (const symbolInfo of symbols) {
    const symbol =
      String(
        symbolInfo.symbol ?? ''
      ).toUpperCase();

    if (!symbol) {
      continue;
    }

    const baseAssetPrecision =
      Number(
        symbolInfo.baseAssetPrecision
      );

    const baseSizePrecision =
      Number(
        symbolInfo.baseSizePrecision
      );

    const quotePrecision =
      Number(
        symbolInfo.quotePrecision
      );

    const quoteAmountPrecision =
      Number(
        symbolInfo.quoteAmountPrecision
      );

    /*
     * baseAssetPrecision — точность количества.
     * baseSizePrecision — минимальный размер ордера.
     */
    const stepSize =
      Number.isFinite(baseAssetPrecision) &&
      baseAssetPrecision >= 0
        ? 10 ** -baseAssetPrecision
        : 0.00000001;

    const minQuantity =
      Number.isFinite(baseSizePrecision) &&
      baseSizePrecision > 0
        ? baseSizePrecision
        : 0;

    const quoteScale =
      Number.isInteger(quotePrecision) &&
      quotePrecision >= 0 &&
      quotePrecision <= 20
        ? quotePrecision
        : 8;

    const minNotional =
      Number.isFinite(quoteAmountPrecision) &&
      quoteAmountPrecision > 0
        ? quoteAmountPrecision
        : 1;

    result.set(symbol, {
      stepSize,
      minQuantity,
      tickSize: 10 ** -quoteScale,
      minNotional,
      quoteScale
    });
  }

  return result;
}

async function loadSymbolFiltersForSymbols(
  restClient: MexcRestClient,
  symbols: Array<{ symbol: string }>
): Promise<Map<string, SymbolFilter>> {
  const exchangeInfo =
    await restClient.getExchangeInfo();

  const allFilters =
    extractSymbolFilters(exchangeInfo);

  const result =
    new Map<string, SymbolFilter>();

  for (const item of symbols) {
    const symbol =
      item.symbol.toUpperCase();

    const filter =
      allFilters.get(symbol);

    if (filter) {
      result.set(symbol, filter);
      continue;
    }

    result.set(symbol, {
      stepSize: 1e-6,
      minQuantity: 0,
      tickSize: 0.0001,
      minNotional: 1,
      quoteScale: 4
    });
  }

  return result;
}

async function main(): Promise<void> {
  ConfigValidator.validateOrThrow(config);

  logger.info(
    '✅ Configuration validated'
  );

  if (
    !config.mexc.apiKey ||
    !config.mexc.apiSecret
  ) {
    throw new Error(
      'MEXC_API_KEY and MEXC_API_SECRET are required'
    );
  }

  if (
    config.trading.startAsset !== 'USDC'
  ) {
    throw new Error(
      'USDC scanner requires START_ASSET=USDC in .env.'
    );
  }

  logger.info(
    {
      startAsset:
        config.trading.startAsset,
      crossAssets:
        config.trading.crossAssets,
      maxPaidLegs:
        MAX_PAID_LEGS
    },
    'Starting USDC triangular arbitrage scanner'
  );

  const authenticatedClient =
    new MexcAuthenticatedClient();

  void (async () => {
    try {
      await telegramNotifier.send(
        '✅ Arbitrage scanner started'
      );

      const balances =
        await authenticatedClient
          .getAccountBalances();

      await telegramNotifier
        .sendBalanceUpdate(
          balances,
          'Startup Balance'
        );
    } catch (error) {
      logger.warn(
        {
          err: error
        },
        'Failed to send startup balance'
      );
    }
  })();

  const symbols =
    await new ExchangeInfoLoader(
      rest
    ).loadSpotSymbols();

  const liquidSymbols =
    symbols.filter(
      (symbol) =>
        ALLOWED_ASSETS.has(
          symbol.baseAsset
        ) &&
        ALLOWED_ASSETS.has(
          symbol.quoteAsset
        )
    );

  const allTriangles =
    new TriangleBuilder().build(
      liquidSymbols,
      config.trading.startAsset,
      config.trading.crossAssets
    );

  const triangles =
    allTriangles.slice(
      0,
      MAX_TRIANGLES
    );

  if (triangles.length === 0) {
    throw new Error(
      'No USDC triangles found'
    );
  }

  const candidateSymbols =
    [
      ...new Set(
        triangles.flatMap(
          (triangle) =>
            triangle.legs.map(
              (leg) => leg.symbol
            )
        )
      )
    ];

  const takerFeesBySymbol =
    await new MexcTradeFeeLoader(
      authenticatedClient,
      logger
    ).loadTakerFees(
      candidateSymbols
    );

  const lowFeeTriangles =
    triangles.filter(
      (triangle) => {
        const paidLegs =
          triangle.legs.filter(
            (leg) => {
              const feeRate =
                takerFeesBySymbol.get(
                  leg.symbol.toUpperCase()
                );

              return (
                feeRate === undefined ||
                Math.abs(feeRate) >
                  ZERO_FEE_EPSILON
              );
            }
          );

        return (
          paidLegs.length <=
          MAX_PAID_LEGS
        );
      }
    );

  const zeroFeeSymbols =
    [
      ...takerFeesBySymbol.entries()
    ]
      .filter(
        ([, feeRate]) =>
          Math.abs(feeRate) <=
          ZERO_FEE_EPSILON
      )
      .map(([symbol]) => symbol);

  logger.info(
    {
      symbolsWithAccountFees:
        takerFeesBySymbol.size,
      zeroFeeSymbolsCount:
        zeroFeeSymbols.length,
      zeroFeeSymbols:
        zeroFeeSymbols.slice(0, 20),
      candidateTrianglesCount:
        triangles.length,
      lowFeeTrianglesCount:
        lowFeeTriangles.length
    },
    'Filtered USDC low-fee triangles'
  );

  if (lowFeeTriangles.length === 0) {
    throw new Error(
      'No USDC low-fee triangles found'
    );
  }

  const usedSymbols =
    [
      ...new Set(
        lowFeeTriangles.flatMap(
          (triangle) =>
            triangle.legs.map(
              (leg) => leg.symbol
            )
        )
      )
    ];

  const symbolFilters =
    await loadSymbolFiltersForSymbols(
      rest,
      usedSymbols.map(
        (symbol) => ({ symbol })
      )
    );

  logger.info(
    {
      symbolFiltersCount:
        symbolFilters.size,
      sample:
        [
          ...symbolFilters.entries()
        ]
          .slice(0, 5)
          .map(
            ([symbol, filter]) => ({
              symbol,
              stepSize:
                filter.stepSize,
              minQuantity:
                filter.minQuantity,
              tickSize:
                filter.tickSize,
              minNotional:
                filter.minNotional,
              quoteScale:
                filter.quoteScale
            })
          )
    },
    'Loaded MEXC symbol filters'
  );

  const books =
    new Map<string, OrderBook>();

  for (const symbol of usedSymbols) {
    try {
      const book =
        new OrderBook(symbol);

      const snapshot =
        await rest.getDepth(
          symbol,
          100
        );

      book.loadSnapshot(snapshot);
      books.set(symbol, book);

      logger.info(
        {
          symbol,
          loadedBooks:
            books.size,
          totalBooks:
            usedSymbols.length
        },
        'Order book snapshot loaded'
      );
    } catch (error) {
      logger.warn(
        {
          err: error,
          symbol
        },
        'Cannot load order book snapshot'
      );
    }

    await sleep(
      SNAPSHOT_DELAY_MS
    );
  }

  const readyTriangles =
    lowFeeTriangles.filter(
      (triangle) =>
        triangle.legs.every(
          (leg) =>
            books.has(leg.symbol)
        )
    );

  if (readyTriangles.length === 0) {
    throw new Error(
      'No ready low-fee triangles found'
    );
  }

  const readySymbols =
    [
      ...new Set(
        readyTriangles.flatMap(
          (triangle) =>
            triangle.legs.map(
              (leg) => leg.symbol
            )
        )
      )
    ];

  const calculator =
    new ArbitrageCalculator(
      takerFeesBySymbol,
      symbolFilters
    );

  const executionConfig:
    OrderExecutionConfig = {
      orderSizeBase: 0.00238,
      minProfitUsdt: 0,
      maxRetries: 3,
      retryDelayMs: 500,
      orderTimeoutMs: 5000,
      enabled:
        config.trading.liveTrading,
      useMarketOrders: true,
      aggressivePriceRate: 0,
      maxRoundingLossRate: 0.001,
      symbolFilters
    };

  const executionService =
    new OrderExecutionService(
      authenticatedClient,
      books,
      executionConfig
    );

  const opportunityService =
    new OpportunityService(
      readyTriangles,
      books,
      calculator,
      performanceLogWriter,
      async (opportunity) => {
        const triangle =
          readyTriangles.find(
            (item) =>
              item.id ===
              opportunity.triangleId
          );

        await csvWriter.write(
          opportunity,
          triangle
        );

        try {
          await telegramNotifier
            .sendOpportunity(
              opportunity
            );
        } catch (error) {
          logger.error(
            {
              err: error
            },
            'Telegram opportunity notify failed'
          );
        }

        if (
          config.trading.liveTrading
        ) {
          try {
            await telegramNotifier
              .sendOrderExecutionStart(
                opportunity
              );

            const balancesBefore =
              await authenticatedClient
                .getAccountBalances();

            await telegramNotifier
              .sendBalanceUpdate(
                balancesBefore,
                'Balance BEFORE Execution'
              );

            const report =
              await executionService
                .executeArbitrage(
                  opportunity
                );

            const balancesAfter =
              await authenticatedClient
                .getAccountBalances();

            await telegramNotifier
              .sendOrderExecuted(
                report,
                balancesAfter
              );

            await performanceLogWriter
              .writeExecution(
                report
              );
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : String(error);

            logger.error(
              {
                err: error,
                errorMessage
              },
              'Order execution failed'
            );

            await telegramNotifier.send(
              `❌ Execution Error:\n` +
              `${errorMessage}`
            );
          }
        }
      },
      csvBestRouteWriter
    );

  const ws =
    new MexcPublicWs(
      readySymbols,
      async (depth) => {
        const book =
          books.get(depth.symbol);

        if (!book) {
          return;
        }

        book.loadSnapshot({
          lastUpdateId:
            depth.toVersion,
          bids:
            depth.bids,
          asks:
            depth.asks
        });

        try {
          await opportunityService
            .evaluateAffected(
              depth.symbol
            );
        } catch (error) {
          logger.error(
            {
              err: error
            },
            'Opportunity evaluation failed'
          );
        }
      },
      () =>
        logger.info(
          'MEXC WebSocket connected'
        ),
      () =>
        logger.warn(
          'MEXC WebSocket disconnected'
        )
    );

  setInterval(() => {
    const now =
      Date.now();

    const snapshots =
      [...books.values()].map(
        (book) =>
          book.getSnapshot(5)
      );

    const readyBooks =
      snapshots.filter(
        (snapshot) =>
          snapshot.ready
      );

    const staleBooks =
      readyBooks.filter(
        (snapshot) =>
          now - snapshot.updatedAt >
          STALE_BOOK_AFTER_MS
      );

    const emptyBooks =
      snapshots.filter(
        (snapshot) =>
          snapshot.bids.length === 0 ||
          snapshot.asks.length === 0
      );

    logger.info(
      {
        totalBooks:
          snapshots.length,
        readyBooks:
          readyBooks.length,
        staleBooks:
          staleBooks.length,
        emptyBooks:
          emptyBooks.length,
        sample:
          snapshots.slice(0, 5).map(
            (snapshot) => ({
              symbol:
                snapshot.symbol,
              ready:
                snapshot.ready,
              bid:
                snapshot.bids[0]?.price ??
                null,
              ask:
                snapshot.asks[0]?.price ??
                null,
              ageMs:
                now - snapshot.updatedAt,
              lastUpdateId:
                snapshot.lastUpdateId
            })
          )
      },
      'USDC low-fee order book health'
    );
  }, HEALTH_CHECK_INTERVAL_MS);

  await ws.connect();

  const shutdown =
    async (): Promise<void> => {
      logger.info(
        'Shutdown started'
      );

      void telegramNotifier
        .send(
          '🛑 Arbitrage scanner stopped'
        )
        .catch((error) => {
          logger.warn(
            {
              err: error
            },
            'Failed to send shutdown message'
          );
        });

      ws.stop();
      process.exit(0);
    };

  process.on(
    'SIGINT',
    shutdown
  );

  process.on(
    'SIGTERM',
    shutdown
  );
}

main().catch(async (error) => {
  const errorMessage =
    error instanceof Error
      ? error.message
      : String(error);

  logger.fatal(
    {
      err: error,
      errorMessage
    },
    'Application failed to start'
  );

  process.exit(1);
});
