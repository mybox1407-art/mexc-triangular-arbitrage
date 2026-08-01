import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Opportunity } from '../domain/types.js';
import pino from 'pino';

const logger = pino({ level: 'info' });

export class PerformanceLogWriter {
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(
    opportunity: Opportunity,
    evaluationTime: number,
    bookAges: Array<{ symbol: string; ageMs: number }>
  ): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch((err) => {
        logger.error(
          { err, filePath: this.filePath },
          'Previous performance log write failed'
        );
      })
      .then(async () => {
        await this.ensureFile();

        const maxBookAge = bookAges.length
          ? Math.max(...bookAges.map((b) => b.ageMs))
          : 0;

        const maxLevelsUsed = opportunity.legs.length
          ? Math.max(...opportunity.legs.map((leg) => leg.levelsUsed))
          : 0;

        const logEntry = {
          timestamp: Date.now(),
          detectedAt: opportunity.detectedAt.toISOString(),
          triangleId: opportunity.triangleId,
          evaluationTime,
          maxBookAge,
          bookAges,
          maxLevelsUsed,
          levelsPerLeg: opportunity.legs.map((leg) => leg.levelsUsed),
          grossRoiAfterFees: opportunity.grossRoiAfterFees,
          netRoi: opportunity.netRoi,
          expectedProfit: opportunity.expectedProfit
        };

        await appendFile(
          this.filePath,
          JSON.stringify(logEntry) + '\n',
          'utf8'
        );
      })
      .catch((err) => {
        logger.error(
          { err, filePath: this.filePath },
          'Performance log write failed'
        );
      });

    return this.writeQueue;
  }

  private async ensureFile(): Promise<void> {
    if (this.initialized) return;

    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      await stat(this.filePath);
    } catch {
      await appendFile(this.filePath, '', 'utf8');
    }

    this.initialized = true;
  }
}
