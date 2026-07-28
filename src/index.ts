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
  
  // ДИАГНОСТИКА: что загрузили с MEXC
  logger.info({
    totalSymbols: symbols.length,
    sampleSymbols: symbols.slice(0, 5).map(s => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
      isSpotTradingAllowed: s.isSpotTradingAllowed
    })),
    uniqueBaseAssets: [...new Set(symbols.map(s => s.baseAsset))].slice(0, 20),
    uniqueQuoteAssets: [...new Set(symbols.map(s => s.quoteAsset))].slice(0, 20)
  }, 'Loaded symbols from MEXC');

  const triangles = new TriangleBuilder().build(symbols, config.trading.startAsset);
  
  // ДИАГНОСТИКА: что построили
  logger.info({
    trianglesCount: triangles.length,
    sampleTriangles: triangles.slice(0, 5).map(t => ({
      id: t.id,
      startAsset: t.startAsset,
      middleAsset1: t.middleAsset1,
      middleAsset2: t.middleAsset2,
      legs: t.legs.map(l => `${l.fromAsset}->${l.toAsset}(${l.symbol}:${l.side})`)
    }))
  }, 'Built triangles');

  if (triangles.length === 0) {
    // ДОПОЛНИТЕЛЬНАЯ ДИАГНОСТИКА при отсутствии треугольников
    const usdtSymbols = symbols.filter(s => s.quoteAsset === config.trading.startAsset || s.baseAsset === config.trading.startAsset);
    logger.warn({
      startAsset: config.trading.startAsset,
      symbolsWithStartAsset: usdtSymbols.length,
      sampleUsdtSymbols: usdtSymbols.slice(0, 10).map(s => s.symbol)
    }, 'No triangles found - diagnostic info');
    
    throw new Error(`No triangles found for ${config.trading.startAsset}`);
  }

  const usedSymbols = [...new Set(triangles.flatMap((triangle) =>
    triangle.legs.map((leg) => leg.symbol)
  ))];

  logger.info({
    symbols: symbols.length,
    triangles: triangles.length,
    subscribedPairs: usedSymbols.length,
    sampleUsedSymbols: usedSymbols.slice(0, 10)
  }, 'Arbitrage scanner initialized');

  const books = new Map<string, OrderBook>();

  for (const symbol of usedSymbols) {
    const book = new OrderBook(symbol);
    books.set(symbol, book);

    const snapshot = await rest.getDepth(symbol, 100);
    book.loadSnapshot(snapshot);
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
      if (!book) return;

      const applied = book.applyDelta(delta);

      if (!applied) {
        logger.warn({ symbol: delta.symbol }, 'Order book out of sync; loading snapshot');

        try {
          const snapshot = await rest.getDepth(delta.symbol, 100);
          book.loadSnapshot(snapshot);
        } catch (error) {
          logger.error({ err: error, symbol: delta.symbol }, 'Cannot reload order book');
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
