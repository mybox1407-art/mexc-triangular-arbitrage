import pino from 'pino';
import { config } from './config.js';
import { OrderBook } from './domain/orderBook.js';
import { ExchangeInfoLoader } from './mexc/ExchangeInfoLoader.js';
import { MexcPublicWs } from './mexc/MexcPublicWs.js';
import { MexcRestClient } from './mexc/MexcRestClient.js';
import { ArbitrageRepository } from './repositories/ArbitrageRepository.js';
import { ArbitrageCalculator } from './services/ArbitrageCalculator.js';
import { CsvOpportunityWriter } from './services/CsvOpportunityWriter.js';
import { OpportunityService } from './services/OpportunityService.js';
import { TriangleBuilder } from './services/TriangleBuilder.js';

const ALLOWED_ASSETS = new Set([
  'USDT',
  'USDC',
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
  'BNB'
]);

const MAX_TRIANGLES = 30;
const SNAPSHOT_DELAY_MS = 300;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const STALE_BOOK_AFTER_MS = 5_000;

const logger = pino({ level: config.logLevel });
const rest = new MexcRestClient();
const repository = new ArbitrageRepository(config.databaseUrl);

const csvWriter = new CsvOpportunityWriter(
  config.csvOpportunitiesPath
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (config.trading.liveTrading) {
    throw new Error(
      'LIVE_TRADING=true is intentionally blocked in MVP. First collect paper-trading statistics.'
    );
  }

  logger.info(
    { startAsset: config.trading.startAsset },
    'Starting arbitrage bot'
  );

  const symbols = await new ExchangeInfoLoader(rest).loadSpotSymbols();

  logger.info(
    {
      totalSymbols: symbols.length,
      sampleSymbols: symbols.slice(0, 5).map((symbol) => ({
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: symbol.status,
        isSpotTradingAllowed: symbol.isSpotTradingAllowed
      }))
    },
    'Loaded symbols from MEXC'
  );

  const liquidSymbols = symbols.filter(
    (symbol) =>
      ALLOWED_ASSETS.has(symbol.baseAsset) &&
      ALLOWED_ASSETS.has(symbol.quoteAsset)
  );

  logger.info(
    {
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
      sampleTriangles: triangles.slice(0, 5).map((triangle) => ({
        id: triangle.id,
        startAsset: triangle.startAsset,
        legs: triangle.legs.map(
          (leg) =>
            `${leg.fromAsset}->${leg.toAsset}(${leg.symbol}:${leg.side})`
        )
      }))
    },
    'Built triangles'
  );

  if (triangles.length === 0) {
    logger.warn(
      {
        startAsset: config.trading.startAsset,
        liquidSymbols: liquidSymbols.map((symbol) => symbol.symbol)
      },
      'No triangles found for allowed assets'
    );

    throw new Error(
      `No liquid triangles found for ${config.trading.startAsset}`
    );
  }

  const usedSymbols = [
    ...new Set(
      triangles.flatMap((triangle) =>
        triangle.legs.map((leg) => leg.symbol)
      )
    )
  ];

  logger.info(
    {
      selectedTriangles: triangles.length,
      subscribedPairs: usedSymbols.length,
      usedSymbols
    },
    'Arbitrage scanner initialized'
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
        {
          err: error,
          symbol
        },
        'Cannot load order book snapshot; symbol will be skipped'
      );
    }

    await sleep(SNAPSHOT_DELAY_MS);
  }

  const readyTriangles = triangles.filter((triangle) =>
    triangle.legs.every((leg) => books.has(leg.symbol))
  );

  if (readyTriangles.length === 0) {
    throw new Error(
      'No triangles with fully initialized order books. Check MEXC REST permissions and rate limits.'
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
      requestedTriangles: triangles.length,
      readyTriangles: readyTriangles.length,
      loadedBooks: books.size,
      subscribedPairs: readySymbols.length,
      readySymbols
    },
    'Order books initialized'
  );

  const calculator = new ArbitrageCalculator();

  const opportunityService = new OpportunityService(
    readyTriangles,
    books,
    calculator,
    async (opportunity) => {
      await csvWriter.write(opportunity);

      logger.info(
        {
          triangle: opportunity.triangleId,
          startAsset: opportunity.startAsset,
          start: opportunity.startAmount,
          final: opportunity.finalAmount,
          grossRoiPct: Number((opportunity.grossRoi * 100).toFixed(4)),
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
        'Paper arbitrage opportunity'
      );

      await repository.saveOpportunity(opportunity);
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
      'Order book health'
    );
  }, HEALTH_CHECK_INTERVAL_MS);

  await ws.connect();

  const shutdown = async (): Promise<void> => {
    logger.info('Shutdown started');
    ws.stop();
    await repository.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Application failed to start');
  await repository.close();
  process.exit(1);
});
