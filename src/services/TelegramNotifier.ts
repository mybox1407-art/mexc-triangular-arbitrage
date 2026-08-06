import pino from 'pino';
import { config } from '../config.js';
import type { Opportunity } from '../domain/types.js';

const logger = pino({ level: 'info' });

export interface ExecutionReport {
  opportunity: any;
  orders: Array<{
    success: boolean;
    orderId?: string;
    error?: string;
    filledQuantity?: number;
    executedPrice?: number;
    timestamp: number;
  }>;
  totalProfitUsdt: number;
  totalFeesUsdt: number;
  executionTimeMs: number;
  status: 'executed' | 'partial' | 'failed' | 'cancelled';
}

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly baseUrl: string | null;

  constructor() {
    const { botToken, chatId } = config.telegram;

    this.enabled = Boolean(botToken && chatId);
    this.baseUrl = botToken
      ? `https://api.telegram.org/bot${botToken}`
      : null;

    if (!this.enabled) {
      logger.warn(
        'Telegram notifications disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set'
      );
    }
  }

  async sendOpportunity(opportunity: Opportunity): Promise<void> {
    const legs = opportunity.legs
      .map(
        (leg, i) =>
          [
            `${i + 1}. ${leg.fromAsset}->${leg.toAsset}`,
            `   ${leg.symbol}:${leg.side}`,
            `   VWAP=${leg.vwap}`,
            `   fee=${leg.feePaidInOutput}`,
            `   levels=${leg.levelsUsed}`
          ].join('\n')
      )
      .join('\n\n');

    const text = [
      '📈 Arbitrage Opportunity',
      '',
      `Triangle: ${opportunity.triangleId}`,
      `Start: ${opportunity.startAmount} ${opportunity.startAsset}`,
      `Final: ${opportunity.finalAmount}`,
      `Gross ROI (after fees): ${(opportunity.grossRoiAfterFees * 100).toFixed(3)}%`,
      `Net ROI: ${(opportunity.netRoi * 100).toFixed(3)}%`,
      `Expected profit: ${opportunity.expectedProfit} ${opportunity.startAsset}`,
      '',
      'Legs:',
      legs
    ].join('\n');

    await this.send(text);
  }

  async sendOrderExecutionStart(opportunity: any): Promise<void> {
    const text = [
      '🚀 Arbitrage Execution STARTED',
      '',
      `Triangle: ${opportunity.triangleId}`,
      `Start Asset: ${opportunity.startAsset}`,
      `Expected Profit: $${opportunity.expectedProfit.toFixed(2)}`,
      `Gross ROI: ${(opportunity.grossRoiAfterFees * 100).toFixed(3)}%`,
      '',
      '⏳ Executing 3 orders...'
    ].join('\n');

    await this.send(text);
  }

  async sendOrderExecuted(report: ExecutionReport, balances: Array<{
    asset: string;
    free: number;
    locked: number;
    total: number;
  }>): Promise<void> {
    const emoji = report.status === 'executed' ? '✅' : 
                  report.status === 'partial' ? '⚠️' : '❌';

    const totalUsd = balances
      .filter(b => ['USDC', 'USDT', 'USD1', 'FDUSD'].includes(b.asset))
      .reduce((sum, b) => sum + b.total, 0);
    
    const totalBtc = balances
      .filter(b => b.asset === 'BTC')
      .reduce((sum, b) => sum + b.total, 0);

    const ordersText = report.orders
      .map((order, i) => 
        [
          `${i + 1}. ${order.success ? '✅' : '❌'} ${order.orderId || 'N/A'}`,
          `   Filled: ${order.filledQuantity?.toFixed(6) || 0}`,
          `   Price: $${order.executedPrice?.toFixed(2) || 0}`,
          `   Error: ${order.error || 'None'}`
        ].join('\n')
      )
      .join('\n\n');

    const topAssets = balances
      .slice(0, 5)
      .map(b => `  ${b.asset}: ${b.total.toFixed(4)}`)
      .join('\n');

    const text = [
      `${emoji} Arbitrage Execution ${report.status.toUpperCase()}`,
      '',
      `Triangle: ${report.opportunity.triangleId}`,
      `Status: ${report.status}`,
      `Execution Time: ${report.executionTimeMs}ms`,
      '',
      '💰 Profit:',
      `Expected: $${report.opportunity.expectedProfit.toFixed(2)}`,
      `Actual: $${report.totalProfitUsdt.toFixed(2)}`,
      `Fees: $${report.totalFeesUsdt.toFixed(2)}`,
      '',
      '📋 Orders:',
      ordersText,
      '',
      '💳 Current Balance:',
      `Total USD: $${totalUsd.toFixed(2)}`,
      `Total BTC: ${totalBtc.toFixed(6)}`,
      '',
      'Top Assets:',
      topAssets,
      '',
      `⏰ Time: ${new Date().toISOString()}`
    ].join('\n');

    await this.send(text);
  }

  async sendBalanceUpdate(
    balances: Array<{
      asset: string;
      free: number;
      locked: number;
      total: number;
    }>,
    title: string = 'Balance Update'
  ): Promise<void> {
    const totalUsd = balances
      .filter(b => ['USDC', 'USDT', 'USD1', 'FDUSD'].includes(b.asset))
      .reduce((sum, b) => sum + b.total, 0);
    
    const totalBtc = balances
      .filter(b => b.asset === 'BTC')
      .reduce((sum, b) => sum + b.total, 0);

    const assetsText = balances
      .filter(b => b.total > 0)
      .map(b => 
        `${b.asset}: ${b.free.toFixed(4)} (free) / ${b.locked.toFixed(4)} (locked) = ${b.total.toFixed(4)} total`
      )
      .join('\n');

    const text = [
      `💳 ${title}`,
      '',
      `Total USD: $${totalUsd.toFixed(2)}`,
      `Total BTC: ${totalBtc.toFixed(6)}`,
      '',
      'Assets:',
      assetsText,
      '',
      `⏰ Time: ${new Date().toISOString()}`
    ].join('\n');

    await this.send(text);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled || !this.baseUrl) {
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(10_000)
      });

      const body = await response.text();

      if (!response.ok) {
        logger.error(
          { status: response.status, body, textPreview: text.slice(0, 500) },
          'Telegram sendMessage failed'
        );
        return;
      }

      logger.info(
        { status: response.status, body },
        'Telegram sendMessage succeeded'
      );
    } catch (error) {
      logger.error({ err: error }, 'Telegram notification error');
    }
  }
}
