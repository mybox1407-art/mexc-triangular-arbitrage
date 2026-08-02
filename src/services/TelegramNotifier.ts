import pino from 'pino';
import { config } from '../config.js';
import type { Opportunity } from '../domain/types.js';

const logger = pino({ level: 'info' });

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
      'Arbitrage opportunity',
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
