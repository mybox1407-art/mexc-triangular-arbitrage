import pino from 'pino';
import { config } from './config.js';
import { OrderBook } from './domain/orderBook.js';
import { ExchangeInfoLoader } from './mexc/ExchangeInfoLoader.js';
import { MexcPublicWs } from './mexc/MexcPublicWs.js';
import { MexcRestClient } from './mexc/MexcRestClient.js';
import { ArbitrageRepository } from './repositories/ArbitrageRepository.js';
import { ArbitrageCalculator } from './services/ArbitrageCalculator.js';
import { OpportunityService } from './services/OpportunityService.js';
import { TriangleBuilder } from './services/TriangleBuilder.js';

const SNAPSHOT_CONCURRENCY = 10;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const STALE_BOOK_AFTER_MS = 5_000;

const logger = pino({ level: config.logLevel });
const rest = new MexcRestClient();
const repository = new ArbitrageRepository(config.databaseUrl);

async function main(): Promise<void> {
  if (config.trading.liveTrading) {
    throw new Error(
      'LIVE_TRADING=true is intentionally blocked in MVP. First collect paper-trading statistics.'
    );
  }

  logger.info({ startAsset: config.trading.startAsset }, 'Starting arbitrage bot');

  const symbols = await new ExchangeInfoLoader(rest).loadSpotSymbols();

  logger.info({
    totalSymbols: symbols.length,
    sampleSymbols: symbols.slice(0, 5).map((symbol) => ({
      symbol: symbol.symbol,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
      status: symbol.status,
      isSpotTradingAllowed: symbol.isSpotTradingAllowed
    })),
    uniqueBaseAssets: [...new Set(symbols.map((symbol) => symbol.baseAsset))].slice(0, 20),
    uniqueQuoteAssets: [...new Set(symbols.map((symbol) => symbol.quoteAsset))].slice(0, 20)
  }, 'Loaded symbols from MEXC');

  const triangles = new TriangleBuilder().build(symbols, config.trading.startAsset);

  logger.info({
    trianglesCount: triangles.length,
    sampleTriangles: triangles.slice(0, 5).map((triangle) => ({
      id: triangle.id,
      startAsset: triangle.startAsset,
      middleAsset1: triangle.middleAsset1,
      middleAsset2: triangle.middleAsset2,
      legs: triangle.legs.map(
        (leg) => `${leg.fromAsset}->${leg.toAsset}(${leg.symbol}:${leg.side})`
      )
    }))
  }, 'Built triangles');

  if (triangles.length === 0) {
    const startAssetSymbols = symbols.filter(
      (symbol) =>
        symbol.quoteAsset === config.trading.startAsset ||
        symbol.baseAsset === config.trading.startAsset
    );

    logger.warn({
      startAsset: config.trading.startAsset,
      symbolsWithStartAsset: startAssetSymbols.length,
      sampleStartAssetSymbols: startAssetSymbols.slice(0, 10).map((symbol) => symbol.symbol)
    }, 'No triangles found - diagnostic info');

    throw new Error(`No triangles found for ${config.trading.startAsset}`);
  }

  const usedSymbols = [
    ...new Set(
      triangles.flatMap((triangle) => triangle.legs.map((leg) => leg.symbol))
    )
  ];

  logger.info({
    symbols: symbols.length,
    triangles: triangles.length,
    subscribedPairs: usedSymbols.length,
    sampleUsedSymbols: usedSymbols.slice(0, 10)
  }, 'Arbitrage scanner initialized');

  const books = new Map<string, OrderBook>();

  for (
    let startIndex = 0;
    startIndex < usedSymbols.length;
    startIndex += SNAPSHOT_CONCURRENCY
  ) {
    const batch = usedSymbols.slice(
      startIndex,
      startIndex + SNAPSHOT_CONCURRENCY
    );

    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const book = new OrderBook(symbol);
        const snapshot = await rest.getDepth(symbol, 100);

        book.loadSnapshot(snapshot);
        books.set(symbol, book);
      })
    );

    const failed = results.filter((result) => result.status === 'rejected');

    if (failed.length > 0) {
      logger.warn({
        failed: failed.length,
        batch
      }, 'Some order book snapshots failed to load');
    }

    logger.info({
      loaded: books.size,
      total: usedSymbols.length,
      failedInBatch: failed.length
    }, 'Loading order book snapshots');
  }

  logger.info({ loadedBooks: books.size }, 'Order books initialized');

  const calculator = new ArbitrageCalculator();

  const opportunityService = new OpportunityService(
    triangles,
    books,
    calculator,
    async (opportunity) => {
      logger.info({
        triangle: opportunity.triangleId,
        start: opportunity.startAmount,
        final: opportunity.finalAmount,
        netRoiPct: Number((opportunity.netRoi * 100).toFixed(4)),
        profit: opportunity.expectedProfit
      }, 'Paper arbitrage opportunity');

      await repository.saveOpportunity(opportunity);
    }
  );

  const ws = new MexcPublicWs(
    usedSymbols,
    async (delta) => {
      const book = books.get(delta.symbol);

      if (!book) {
        return;
      }

      const applied = book.applyDelta(delta);

      if (!applied) {
        logger.warn(
          { symbol: delta.symbol },
          'Order book out of sync; loading fresh snapshot'
        );

        try {
          const snapshot = await rest.getDepth(delta.symbol, 100);
          book.loadSnapshot(snapshot);
        } catch (error) {
          logger.error(
            { err: error, symbol: delta.symbol },
            'Cannot reload order book'
          );
        }

        return;
      }

      try {
        await opportunityService.evaluateAffected(delta.symbol);
      } catch (error) {
        logger.error({ err: error }, 'Opportunity evaluation failed');
      }
    },
    () => logger.info('MEXC WebSocket connected'),
    () => logger.warn('MEXC WebSocket disconnected')
  );

  setInterval(() => {
    const now = Date.now();
    const snapshots = [...books.values()].map((book) => book.getSnapshot(5));

    const readyBooks = snapshots.filter((snapshot) => snapshot.ready);
    const staleBooks = readyBooks.filter(
      (snapshot) => now - snapshot.updatedAt > STALE_BOOK_AFTER_MS
    );
    const emptyBooks = snapshots.filter(
      (snapshot) =>
        snapshot.bids.length === 0 ||
        snapshot.asks.length === 0
    );

    logger.info({
      totalBooks: snapshots.length,
      readyBooks: readyBooks.length,
      staleBooks: staleBooks.length,
      emptyBooks: emptyBooks.length,
      sample: snapshots.slice(0, 3).map((snapshot) => ({
        symbol: snapshot.symbol,
        ready: snapshot.ready,
        bid: snapshot.bids[0]?.price ?? null,
        ask: snapshot.asks[0]?.price ?? null,
        ageMs: now - snapshot.updatedAt,
        lastUpdateId: snapshot.lastUpdateId
      }))
    }, 'Order book health');
  }, HEALTH_CHECK_INTERVAL_MS);

  ws.connect();

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
