import {
  appendFile,
  mkdir,
  stat
} from 'node:fs/promises';

import {
  dirname
} from 'node:path';

import type {
  Opportunity
} from '../domain/types.js';

import type {
  ExecutionReport
} from './OrderExecutionService.js';

import pino from 'pino';

const logger = pino({
  level: 'info'
});

type BookAge = {
  symbol: string;
  ageMs: number;
};

export class PerformanceLogWriter {
  private initialized = false;
  private writeQueue: Promise<void> =
    Promise.resolve();

  constructor(
    private readonly filePath: string
  ) {}

  async write(
    opportunity: Opportunity,
    evaluationTime: number,
    bookAges: BookAge[]
  ): Promise<void> {
    this.writeQueue =
      this.writeQueue
        .catch((error) => {
          logger.error(
            {
              err: error,
              filePath: this.filePath
            },
            'Previous performance log write failed'
          );
        })
        .then(async () => {
          await this.ensureFile();

          const maxBookAge =
            bookAges.length > 0
              ? Math.max(
                  ...bookAges.map(
                    (book) => book.ageMs
                  )
                )
              : 0;

          const maxLevelsUsed =
            opportunity.legs.length > 0
              ? Math.max(
                  ...opportunity.legs.map(
                    (leg) =>
                      leg.levelsUsed
                  )
                )
              : 0;

          const logEntry = {
            type: 'opportunity',
            timestamp: Date.now(),

            detectedAt:
              opportunity.detectedAt
                .toISOString(),

            triangleId:
              opportunity.triangleId,

            startAsset:
              opportunity.startAsset,

            startAmount:
              opportunity.startAmount,

            finalAmount:
              opportunity.finalAmount,

            evaluationTime,
            maxBookAge,
            bookAges,
            maxLevelsUsed,

            levelsPerLeg:
              opportunity.legs.map(
                (leg) =>
                  leg.levelsUsed
              ),

            grossRoiBeforeFees:
              opportunity.grossRoiBeforeFees,

            grossRoiAfterFees:
              opportunity.grossRoiAfterFees,

            netRoi:
              opportunity.netRoi,

            totalFeeRate:
              opportunity.totalFeeRate,

            totalFeeInStartAsset:
              opportunity.totalFeeInStartAsset,

            expectedProfit:
              opportunity.expectedProfit
          };

          await appendFile(
            this.filePath,
            JSON.stringify(logEntry) +
              '\n',
            'utf8'
          );
        })
        .catch((error) => {
          logger.error(
            {
              err: error,
              filePath: this.filePath
            },
            'Performance opportunity log write failed'
          );
        });

    return this.writeQueue;
  }

  async writeExecution(
    report: ExecutionReport
  ): Promise<void> {
    this.writeQueue =
      this.writeQueue
        .catch((error) => {
          logger.error(
            {
              err: error,
              filePath: this.filePath
            },
            'Previous performance log write failed'
          );
        })
        .then(async () => {
          await this.ensureFile();

          const startAmount =
            report.opportunity.startAmount;

          const expectedProfit =
            report.opportunity.expectedProfit;

          const expectedRoi =
            startAmount > 0
              ? expectedProfit /
                startAmount
              : 0;

          const actualRoi =
            report.actualRoi;

          const executionSlippage =
            actualRoi -
            expectedRoi;

          const logEntry = {
            type: 'execution',
            timestamp: Date.now(),

            detectedAt:
              report.opportunity.detectedAt
                .toISOString(),

            triangleId:
              report.opportunity.triangleId,

            startAsset:
              report.opportunity.startAsset,

            startAmount,

            expectedFinal:
              report.opportunity.finalAmount,

            actualFinal:
              report.actualFinalAmount ??
              null,

            expectedProfit,
            actualProfit:
              report.totalProfitUsdt,

            expectedRoi,
            actualRoi,
            executionSlippage,

            status:
              report.status,

            executionTimeMs:
              report.executionTimeMs,

            totalFeesUsdt:
              report.totalFeesUsdt,

            feesAreActual:
              report.feesAreActual,

            feesByAsset:
              report.feesByAsset,

            orders:
              report.orders.map((order) => ({
                success:
                  order.success,

                orderId:
                  order.orderId ??
                  null,

                filledQuantity:
                  order.filledQuantity ??
                  null,

                receivedQuantity:
                  order.receivedQuantity ??
                  null,

                executedPrice:
                  order.executedPrice ??
                  null,

                executedQuoteQty:
                  order.executedQuoteQty ??
                  null,

                fees:
                  order.fees ??
                  [],

                error:
                  order.error ??
                  null,

                timestamp:
                  order.timestamp
              }))
          };

          await appendFile(
            this.filePath,
            JSON.stringify(logEntry) +
              '\n',
            'utf8'
          );
        })
        .catch((error) => {
          logger.error(
            {
              err: error,
              filePath: this.filePath
            },
            'Performance execution log write failed'
          );
        });

    return this.writeQueue;
  }

  private async ensureFile(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(
      dirname(this.filePath),
      {
        recursive: true
      }
    );

    try {
      await stat(this.filePath);
    } catch {
      await appendFile(
        this.filePath,
        '',
        'utf8'
      );
    }

    this.initialized = true;
  }
}
