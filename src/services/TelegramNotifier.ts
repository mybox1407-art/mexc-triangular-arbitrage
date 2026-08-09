import pino from 'pino';
import { config } from '../config.js';
import type { Opportunity } from '../domain/types.js';

const logger = pino({
  level: 'info'
});

export type ExecutionStatus =
  | 'FILLED_PROFITABLE'
  | 'FILLED_UNPROFITABLE'
  | 'PARTIAL'
  | 'FAILED';

export interface TelegramOrderFee {
  amount: number;
  asset: string;
}

export interface TelegramOrder {
  success: boolean;
  orderId?: string;
  error?: string;
  filledQuantity?: number;
  receivedQuantity?: number;
  executedPrice?: number;
  executedQuoteQty?: number;
  fees?: TelegramOrderFee[];
  timestamp: number;
  isMarketOrder?: boolean;
}

export interface ExecutionReport {
  opportunity: Opportunity;
  orders: TelegramOrder[];
  totalProfitUsdt: number;
  totalFeesUsdt: number;
  feesByAsset: Array<{
    asset: string;
    amount: number;
  }>;
  feesAreActual: boolean;
  actualRoi: number;
  executionTimeMs: number;
  status: ExecutionStatus;
  actualFinalAmount?: number;
  profitIsActual?: boolean;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly baseUrl: string | null;

  constructor() {
    const {
      botToken,
      chatId
    } = config.telegram;

    this.enabled =
      Boolean(botToken && chatId);

    this.baseUrl = botToken
      ? `https://api.telegram.org/bot${botToken}`
      : null;

    if (!this.enabled) {
      logger.warn(
        'Telegram notifications disabled: ' +
        'TELEGRAM_BOT_TOKEN or ' +
        'TELEGRAM_CHAT_ID not set'
      );
    }
  }

  async sendOpportunity(
    opportunity: Opportunity
  ): Promise<void> {
    const legs =
      opportunity.legs
        .map((leg, index) =>
          [
            `${index + 1}. ` +
            `${leg.fromAsset}->${leg.toAsset}`,
            `   ${leg.symbol}:${leg.side}`,
            `   VWAP=${this.formatNumber(leg.vwap, 8)}`,
            `   fee=${this.formatNumber(
              leg.feePaidInOutput,
              8
            )}`,
            `   levels=${leg.levelsUsed}`
          ].join('\n')
        )
        .join('\n\n');

    const text = [
      '📈 Arbitrage Opportunity',
      '',
      `Triangle: ${opportunity.triangleId}`,
      `Start: ${this.formatNumber(
        opportunity.startAmount,
        8
      )} ${opportunity.startAsset}`,
      `Final: ${this.formatNumber(
        opportunity.finalAmount,
        8
      )} ${opportunity.startAsset}`,
      `Gross ROI (after fees): ` +
        `${(
          opportunity.grossRoiAfterFees * 100
        ).toFixed(3)}%`,
      `Net ROI: ` +
        `${(
          opportunity.netRoi * 100
        ).toFixed(3)}%`,
      `Expected profit: ` +
        `${this.formatNumber(
          opportunity.expectedProfit,
          8
        )} ${opportunity.startAsset}`,
      '',
      'Legs:',
      legs
    ].join('\n');

    await this.send(text);
  }

  async sendOrderExecutionStart(
    opportunity: Opportunity
  ): Promise<void> {
    const text = [
      '🚀 Arbitrage Execution STARTED',
      '',
      `Triangle: ${opportunity.triangleId}`,
      `Start Asset: ${opportunity.startAsset}`,
      `Start Amount: ${this.formatNumber(
        opportunity.startAmount,
        8
      )}`,
      `Expected Profit: ${this.formatNumber(
        opportunity.expectedProfit,
        8
      )} ${opportunity.startAsset}`,
      `Gross ROI: ${(
        opportunity.grossRoiAfterFees * 100
      ).toFixed(3)}%`,
      '',
      '⏳ Executing 3 market orders...'
    ].join('\n');

    await this.send(text);
  }

  async sendOrderExecuted(
    report: ExecutionReport,
    balances: Balance[]
  ): Promise<void> {
    const emoji =
      report.status ===
      'FILLED_PROFITABLE'
        ? '✅'
        : report.status ===
          'FILLED_UNPROFITABLE'
          ? '🔻'
          : report.status ===
            'PARTIAL'
            ? '⚠️'
            : '❌';

    const totalUsd =
      balances
        .filter((balance) =>
          [
            'USDC',
            'USDT',
            'USD1',
            'FDUSD'
          ].includes(balance.asset)
        )
        .reduce(
          (sum, balance) =>
            sum + balance.total,
          0
        );

    const totalBtc =
      balances
        .filter(
          (balance) =>
            balance.asset === 'BTC'
        )
        .reduce(
          (sum, balance) =>
            sum + balance.total,
          0
        );

    const ordersText =
      report.orders
        .map((order, index) => {
          const fees =
            order.fees &&
            order.fees.length > 0
              ? order.fees
                  .map(
                    (fee) =>
                      `${this.formatNumber(
                        fee.amount,
                        8
                      )} ${fee.asset}`
                  )
                  .join(', ')
              : 'not loaded';

          return [
            `${index + 1}. ` +
              `${order.success ? '✅' : '❌'} ` +
              `${order.orderId ?? 'N/A'}`,
            `   Filled: ${this.formatNumber(
              order.filledQuantity,
              8
            )}`,
            `   Received: ${this.formatNumber(
              order.receivedQuantity,
              8
            )}`,
            `   Price: ${this.formatNumber(
              order.executedPrice,
              8
            )}`,
            `   Quote Qty: ${this.formatNumber(
              order.executedQuoteQty,
              8
            )}`,
            `   Fees: ${fees}`,
            `   Error: ${order.error ?? 'None'}`
          ].join('\n');
        })
        .join('\n\n');

    const feesText =
      report.feesAreActual &&
      report.feesByAsset.length > 0
        ? report.feesByAsset
            .map(
              (fee) =>
                `${this.formatNumber(
                  fee.amount,
                  8
                )} ${fee.asset}`
            )
            .join(', ')
        : 'unavailable';

    const topAssets =
      balances
        .filter(
          (balance) =>
            balance.total > 0
        )
        .slice(0, 10)
        .map(
          (balance) =>
            `  ${balance.asset}: ` +
            `${this.formatNumber(
              balance.total,
              8
            )}`
        )
        .join('\n');

    const expectedProfit =
      report.opportunity.expectedProfit;

    const expectedRoi =
      report.opportunity.startAmount > 0
        ? expectedProfit /
          report.opportunity.startAmount
        : 0;

    const actualFinal =
      report.actualFinalAmount;

    const text = [
      `${emoji} Arbitrage Execution ` +
        `${report.status}`,
      '',
      `Triangle: ` +
        `${report.opportunity.triangleId}`,
      `Status: ${report.status}`,
      `Execution Time: ` +
        `${report.executionTimeMs}ms`,
      '',
      '💰 Result:',
      `Start: ${this.formatNumber(
        report.opportunity.startAmount,
        8
      )} ${report.opportunity.startAsset}`,
      `Expected Final: ${this.formatNumber(
        report.opportunity.finalAmount,
        8
      )}`,
      `Actual Final: ${this.formatNumber(
        actualFinal,
        8
      )}`,
      '',
      `Expected Profit: ` +
        `${this.formatSigned(
          expectedProfit,
          8
        )} ${report.opportunity.startAsset}`,
      `Actual Profit: ` +
        `${this.formatSigned(
          report.totalProfitUsdt,
          8
        )} ${report.opportunity.startAsset}`,
      `Expected ROI: ` +
        `${(expectedRoi * 100).toFixed(4)}%`,
      `Actual ROI: ` +
        `${(report.actualRoi * 100).toFixed(4)}%`,
      `Execution Slippage: ` +
        `${(
          (report.actualRoi - expectedRoi) *
          100
        ).toFixed(4)}%`,
      `Fees: ${feesText}`,
      '',
      '📋 Orders:',
      ordersText,
      '',
      '💳 Current Balance:',
      `Total USD: $${totalUsd.toFixed(6)}`,
      `Total BTC: ${totalBtc.toFixed(8)}`,
      '',
      'Top Assets:',
      topAssets || '  No assets',
      '',
      `⏰ Time: ${new Date().toISOString()}`
    ].join('\n');

    await this.send(text);
  }

  async sendBalanceUpdate(
    balances: Balance[],
    title: string = 'Balance Update'
  ): Promise<void> {
    const totalUsd =
      balances
        .filter((balance) =>
          [
            'USDC',
            'USDT',
            'USD1',
            'FDUSD'
          ].includes(balance.asset)
        )
        .reduce(
          (sum, balance) =>
            sum + balance.total,
          0
        );

    const totalBtc =
      balances
        .filter(
          (balance) =>
            balance.asset === 'BTC'
        )
        .reduce(
          (sum, balance) =>
            sum + balance.total,
          0
        );

    const assetsText =
      balances
        .filter(
          (balance) =>
            balance.total > 0
        )
        .map((balance) =>
          [
            `${balance.asset}: ` +
              `${this.formatNumber(
                balance.free,
                8
              )} free / ` +
              `${this.formatNumber(
                balance.locked,
                8
              )} locked = ` +
              `${this.formatNumber(
                balance.total,
                8
              )} total`
          ].join('')
        )
        .join('\n');

    const text = [
      `💳 ${title}`,
      '',
      `Total USD: $${totalUsd.toFixed(6)}`,
      `Total BTC: ${totalBtc.toFixed(8)}`,
      '',
      'Assets:',
      assetsText || 'No non-zero assets',
      '',
      `⏰ Time: ${new Date().toISOString()}`
    ].join('\n');

    await this.send(text);
  }

  async send(
    text: string
  ): Promise<void> {
    if (
      !this.enabled ||
      !this.baseUrl
    ) {
      return;
    }

    try {
      const response =
        await fetch(
          `${this.baseUrl}/sendMessage`,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify({
              chat_id:
                config.telegram.chatId,
              text,
              disable_web_page_preview:
                true
            }),
            signal:
              AbortSignal.timeout(10_000)
          }
        );

      const body =
        await response.text();

      if (!response.ok) {
        logger.error(
          {
            status: response.status,
            body,
            textPreview: text.slice(0, 500)
          },
          'Telegram sendMessage failed'
        );

        return;
      }

      logger.info(
        {
          status: response.status,
          body
        },
        'Telegram sendMessage succeeded'
      );
    } catch (error) {
      logger.error(
        {
          err: error
        },
        'Telegram notification error'
      );
    }
  }

  private formatNumber(
    value: number | undefined,
    digits: number
  ): string {
    if (
      value === undefined ||
      !Number.isFinite(value)
    ) {
      return 'N/A';
    }

    return value.toFixed(digits);
  }

  private formatSigned(
    value: number,
    digits: number
  ): string {
    if (!Number.isFinite(value)) {
      return 'N/A';
    }

    return value >= 0
      ? `+${value.toFixed(digits)}`
      : value.toFixed(digits);
  }
}
