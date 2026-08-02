import pino from 'pino';
import { config } from './config.js';
import { OrderBook } from './domain/orderBook.js';
import { ExchangeInfoLoader } from './mexc/ExchangeInfoLoader.js';
import { MexcAuthenticatedClient } from './mexc/MexcAuthenticatedClient.js';
import { MexcPublicWs } from './mexc/MexcPublicWs.js';
import { MexcRestClient } from './mexc/MexcRestClient.js';
import { MexcTradeFeeLoader } from './mexc/MexcTradeFeeLoader.js';
import { ArbitrageCalculator } from './services/ArbitrageCalculator.js';
import { CsvOpportunityWriter } from './services/CsvOpportunityWriter.js';
import { OpportunityService } from './services/OpportunityService.js';
import { PerformanceLogWriter } from './services/PerformanceLogWriter.js';
import { TelegramNotifier } from './services/TelegramNotifier.js';
import { TriangleBuilder } from './services/TriangleBuilder.js';

const ALLOWED_ASSETS = new Set([
  'USDC',
  'USDT',
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'LTC',
  'BCH',
  'TRX',
  'ADA',
  'LINK',
  'AVAX',
  'DOT',
  'TON',
  'BNB',
  'SUI',
  'APT',
  'NEAR',
  'ATOM',
  'FIL',
  'ARB',
  'OP',
  'AAVE',
  'UNI',
  'ETC',
  'XLM',
  'HBAR',
  'ICP',
  'INJ',
  'SEI',
  'TIA',
  'WLD',
  'CRV',
  'MKR',
  'MATIC',
  'POL',
  'PEPE',
  'SHIB',
  'FLOKI',
  'WIF',
  'BONK',
  'PENGU',
  'JUP',
  'KAS',
  'RUNE',
  'BOME',
  'NOT',
  'ORDI',
  'PNUT',
  'POPCAT',
  'MEW',
  'CHILLGUY',
  'TAO',
  'FET',
  'GOAT',
  'MYRO',
  'NEIRO',
  'THE',
  'PONKE',
  'TRUMP',
  'MELANIA',
  'PI'
]);

const MAX_TRIANGLES = Number.POSITIVE_INFINITY;
const MAX_PAID_LEGS = 1;
const SNAPSHOT_DELAY_MS = 300;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const STALE_BOOK_AFTER_MS = 5_000;
const ZERO_FEE_EPSILON = 1e-12;

const logger = pino({ level: config.logLevel });
const rest = new MexcRestClient();

const csvWriter = new CsvOpportunityWriter(
  config.csvOpportunitiesPath
);

const performanceLogWriter = new PerformanceLogWriter(
  config.performanceLogPath
);

const telegramNotifier = new TelegramNotifier();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (config.trading.liveTrading) {
    throw new Error(
      'LIVE_TRADING=true is intentionally blocked in MVP. First collect paper-trading statistics.'
    );
  }

  if (!config.mexc.apiKey || !config.mexc.apiSecret) {
    throw new Error(
      'MEXC_API_KEY and MEXC_API_SECRET are required for symbol-specific fee mode.'
    );
  }

  if (config.trading.startAsset !== 'USDC') {
    throw new Error(
      'USDC scanner requires START_ASSET=USDC in .env.'
    );
  }

  logger.info(
    {
      startAsset: config.trading.startAsset,
      maxPaidLegs: MAX_PAID_LEGS
    },
    'Starting USDC low-fee triangular arbitrage scanner'
  );

  void telegramNotifier
    .send('✅ Arbitrage scanner started')
    .catch((error) => {
      logger.warn({ err: error }, 'Failed to send startup Telegram message');
    });

  const symbols = await new ExchangeInfoLoader(rest).loadSpotSymbols();

  const liquidSymbols = symbols.filter(
    (symbol) =>
      ALLOWED_ASSETS.has(symbol.baseAsset) &&
      ALLOWED_ASSETS.has(symbol.quoteAsset)
  );

  logger.info(
    {
      totalSymbols: symbols.length,
      totalLiquidSymbols: liquidSymbols.length,
      liquidSymbols: liquidSymbols.map((symbol) => symbol.symbol)
    },
    'Filtered liquid symbols'
  );

  const allTriangles = new TriangleBuilder().build(
    liquidSymbols,
    config.trading.startAsset
  );

  const triangles = allTriangles.slice(0, MAX_TRIANGLES);

  logger.info(
    {
      allTrianglesCount: allTriangles.length,
      selectedTrianglesCount: triangles.length,
      sampleTriangles: triangles.slice(0, 10).map((triangle) => ({
        id: triangle.id,
        legs: triangle.legs.map(
          (leg) =>
            `${leg.fromAsset}->${leg.toAsset}(${leg.symbol}:${leg.side})`
        )
      }))
    },
    'Built USDC triangles'
  );

  if (triangles.length === 0) {
    throw new Error('No USDC triangles found for allowed assets.');
  }

  const candidateSymbols = [
    ...new Set(
      triangles.flatMap((triangle) =>
        triangle.legs.map((leg) => leg.symbol)
      )
    )
  ];

  const authenticatedClient = new MexcAuthenticatedClient();

  const takerFeesBySymbol = await new MexcTradeFeeLoader(
    authenticatedClient,
    logger
  ).loadTakerFees(candidateSymbols);

  const zeroFeeSymbols = [...takerFeesBySymbol.entries()]
    .filter(([, feeRate]) => Math.abs(feeRate) <= ZERO_FEE_EPSILON)
    .map(([symbol]) => symbol);

  const lowFeeTriangles = triangles.filter((triangle) => {
    const paidLegs = triangle.legs.filter((leg) => {
      const feeRate = takerFeesBySymbol.get(leg.symbol.toUpperCase());

      return (
        feeRate === undefined ||
        Math.abs(feeRate) > ZERO_FEE_EPSILON
      );
    });

    return paidLegs.length <= MAX_PAID_LEGS;
  });

  logger.info(
    {
      symbolsWithAccountFees: takerFeesBySymbol.size,
      zeroFeeSymbols,
      candidateTrianglesCount: triangles.length,
      lowFeeTrianglesCount: lowFeeTriangles.length,
      maxPaidLegs: MAX_PAID_LEGS,
      lowFeeTriangleIds: lowFeeTriangles.map((triangle) => triangle.id)
    },
    'Filtered USDC low-fee triangles'
  );

  if (lowFeeTriangles.length === 0) {
    throw new Error(
      'No USDC triangles with no more than one paid leg were found.'
    );
  }

  const usedSymbols = [
    ...new Set(
      lowFeeTriangles.flatMap((triangle) =>
        triangle.legs.map((leg) => leg.symbol)
      )
    )
  ];

  logger.info(
    {
      selectedTriangles: lowFeeTriangles.length,
      subscribedPairs: usedSymbols.length,
      usedSymbols
    },
    'USDC low-fee scanner initialized'
  );

  const books = new Map<string, OrderBook>();

  for (const symbol of usedSymbols) {
    try {
      const book = new OrderBook(symbol);
      const snapshot = await rest.getDepth(symbol, 100);

      book.loadSnapshot(snapshot);
      books.set(symbol, book);

      logger.info(
        {
          symbol,
          loadedBooks: books.size,
          totalBooks: usedSymbols.length
        },
        'Order book snapshot loaded'
      );
    } catch (error) {
      logger.warn(
        { err: error, symbol },
        'Cannot load order book snapshot; symbol will be skipped'
      );
    }

    await sleep(SNAPSHOT_DELAY_MS);
  }

  const readyTriangles = lowFeeTriangles.filter((triangle) =>
    triangle.legs.every((leg) => books.has(leg.symbol))
  );

  if (readyTriangles.length === 0) {
    throw new Error(
      'No low-fee USDC triangles with fully initialized order books.'
    );
  }

  const readySymbols = [
    ...new Set(
      readyTriangles.flatMap((triangle) =>
        triangle.legs.map((leg) => leg.symbol)
      )
    )
  ];

  logger.info(
    {
      requestedLowFeeTriangles: lowFeeTriangles.length,
      readyLowFeeTriangles: readyTriangles.length,
      loadedBooks: books.size,
      subscribedPairs: readySymbols.length,
      readySymbols
    },
    'USDC low-fee order books initialized'
  );

  const calculator = new ArbitrageCalculator(takerFeesBySymbol);

  const opportunityService = new OpportunityService(
    readyTriangles,
    books,
    calculator,
    performanceLogWriter,
    async (opportunity) => {
      await csvWriter.write(opportunity);

      logger.info(
        {
          triangle: opportunity.triangleId,
          startAsset: opportunity.startAsset,
          start: opportunity.startAmount,
          final: opportunity.finalAmount,
          grossRoiPct: Number(
            (opportunity.grossRoiAfterFees * 100).toFixed(4)
          ),
          netRoiPct: Number((opportunity.netRoi * 100).toFixed(4)),
          profit: opportunity.expectedProfit,
          legs: opportunity.legs.map((leg) => ({
            symbol: leg.symbol,
            side: leg.side,
            route: `${leg.fromAsset}->${leg.toAsset}`,
            input: leg.inputAmount,
            output: leg.outputAmount,
            vwap: leg.vwap,
            fee: leg.feePaidInOutput,
            levelsUsed: leg.levelsUsed
          }))
        },
        'USDC low-fee paper arbitrage opportunity'
      );

      logger.info(
        {
          triangle: opportunity.triangleId,
          grossRoiAfterFees: opportunity.grossRoiAfterFees,
          netRoi: opportunity.netRoi,
          profit: opportunity.expectedProfit
        },
        'Sending Telegram opportunity notification'
      );

      try {
        await telegramNotifier.sendOpportunity(opportunity);

        logger.info(
          {
            triangle: opportunity.triangleId
          },
          'Telegram opportunity notification sent'
        );
      } catch (error) {
        logger.error(
          {
            err: error,
            triangle: opportunity.triangleId
          },
          'Telegram notify failed'
        );
      }
    }
  );

  const ws = new MexcPublicWs(
    readySymbols,
    async (depth) => {
      const book = books.get(depth.symbol);

      if (!book) {
        return;
      }

      book.loadSnapshot({
        lastUpdateId: depth.toVersion,
        bids: depth.bids,
        asks: depth.asks
      });

      try {
        await opportunityService.evaluateAffected(depth.symbol);
      } catch (error) {
        logger.error({ err: error }, 'Opportunity evaluation failed');
      }
    },
    () => logger.info('MEXC WebSocket connected'),
    () => logger.warn('MEXC WebSocket disconnected')
  );

  setInterval(() => {
    const now = Date.now();
    const snapshots = [...books.values()].map((book) =>
      book.getSnapshot(5)
    );

    const readyBooks = snapshots.filter((snapshot) => snapshot.ready);

    const staleBooks = readyBooks.filter(
      (snapshot) => now - snapshot.updatedAt > STALE_BOOK_AFTER_MS
    );

    const emptyBooks = snapshots.filter(
      (snapshot) =>
        snapshot.bids.length === 0 || snapshot.asks.length === 0
    );

    logger.info(
      {
        totalBooks: snapshots.length,
        readyBooks: readyBooks.length,
        staleBooks: staleBooks.length,
        emptyBooks: emptyBooks.length,
        sample: snapshots.slice(0, 5).map((snapshot) => ({
          symbol: snapshot.symbol,
          ready: snapshot.ready,
          bid: snapshot.bids[0]?.price ?? null,
          ask: snapshot.asks[0]?.price ?? null,
          ageMs: now - snapshot.updatedAt,
          lastUpdateId: snapshot.lastUpdateId
        }))
      },
      'USDC low-fee order book health'
    );
  }, HEALTH_CHECK_INTERVAL_MS);

  await ws.connect();

  const shutdown = async (): Promise<void> => {
    logger.info('Shutdown started');

    void telegramNotifier
      .send('🛑 Arbitrage scanner stopped')
      .catch((error) => {
        logger.warn({ err: error }, 'Failed to send shutdown Telegram message');
      });

    ws.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Application failed to start');
  process.exit(1);
});
