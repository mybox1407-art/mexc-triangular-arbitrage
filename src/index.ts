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

  const symbols = await new ExchangeInfoLoader(rest).loadSpotSymbols();
  const triangles = new TriangleBuilder().build(symbols, config.trading.startAsset);

  if (triangles.length === 0) {
    throw new Error(`No triangles found for ${config.trading.startAsset}`);
  }

  const usedSymbols = [...new Set(triangles.flatMap((triangle) =>
    triangle.legs.map((leg) => leg.symbol)
  ))];

  logger.info({
    symbols: symbols.length,
    triangles: triangles.length,
    subscribedPairs: usedSymbols.length
  }, 'Arbitrage scanner initialized');

  const books = new Map<string, OrderBook>();

  for (const symbol of usedSymbols) {
    const book = new OrderBook(symbol);
    books.set(symbol, book);

    const snapshot = await rest.getDepth(symbol, 100);
    book.loadSnapshot(snapshot);
  }

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
