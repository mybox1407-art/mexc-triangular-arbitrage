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
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureFile();

      const maxBookAge = Math.max(...bookAges.map(b => b.ageMs));
      const maxLevelsUsed = Math.max(...opportunity.legs.map(leg => leg.levelsUsed));

      const logEntry = {
        timestamp: Date.now(),
        detectedAt: opportunity.detectedAt.toISOString(),
        triangleId: opportunity.triangleId,
        evaluationTime,
        maxBookAge,
        bookAges,
        maxLevelsUsed,
        levelsPerLeg: opportunity.legs.map(leg => leg.levelsUsed),
        grossRoiAfterFees: opportunity.grossRoiAfterFees,
        netRoi: opportunity.netRoi,
        expectedProfit: opportunity.expectedProfit
      };

      // Пишем в файл в JSON Lines формате
      await appendFile(this.filePath, JSON.stringify(logEntry) + '\n', 'utf8');
    });

    return this.writeQueue;
  }

  private async ensureFile(): Promise<void> {
    if (this.initialized) return;

    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      await stat(this.filePath);
    } catch {
      // Файл не существует — создаём пустым
      await appendFile(this.filePath, '', 'utf8');
    }

    this.initialized = true;
  }
}
