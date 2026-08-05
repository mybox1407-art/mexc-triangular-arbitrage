import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stringify } from 'csv-stringify';
import type { Opportunity } from '../domain/types.js';
import type { Triangle } from '../domain/types.js';

export class CsvOpportunityWriter {
  private readonly writer: ReturnType<typeof stringify>;
  private readonly stream: ReturnType<typeof createWriteStream>;
  private initialized = false;

  constructor(
    private readonly outputPath: string,
    private readonly triangles?: Triangle[] // Добавлено для маппинга
  ) {
    this.stream = createWriteStream(outputPath);

    this.writer = stringify({
      header: true,
      columns: [
        'detectedAt',
        'triangleId',
        'startAsset',
        'startAmount',
        'finalAmount',
        'expectedProfit',
        'grossRoiBeforeFees',
        'grossRoiAfterFees',
        'netRoi',
        'totalFeeRate',
        'totalFeeInStartAsset',
        'leg1Symbol',
        'leg1Side',
        'leg1FromAsset',
        'leg1ToAsset',
        'leg1InputAmount',
        'leg1OutputAmount',
        'leg1Vwap',
        'leg1FeePaidInOutput',
        'leg1LevelsUsed',
        'leg2Symbol',
        'leg2Side',
        'leg2FromAsset',
        'leg2ToAsset',
        'leg2InputAmount',
        'leg2OutputAmount',
        'leg2Vwap',
        'leg2FeePaidInOutput',
        'leg2LevelsUsed',
        'leg3Symbol',
        'leg3Side',
        'leg3FromAsset',
        'leg3ToAsset',
        'leg3InputAmount',
        'leg3OutputAmount',
        'leg3Vwap',
        'leg3FeePaidInOutput',
        'leg3LevelsUsed',
        'isCrossRoute',        // НОВОЕ
        'crossAsset'           // НОВОЕ
      ],
      cast: {
        date: (value) => value.toISOString()
      }
    });

    void pipeline(this.writer, this.stream).catch(() => {
      // Ignore pipeline errors
    });
  }

  async write(
    opportunity: Opportunity,
    triangle?: Triangle // Добавлено
  ): Promise<void> {
    if (!this.initialized) {
      await new Promise<void>((resolve) => {
        this.stream.on('open', () => resolve());
      });
      this.initialized = true;
    }

    const record: Record<string, unknown> = {
      detectedAt: opportunity.detectedAt,
      triangleId: opportunity.triangleId,
      startAsset: opportunity.startAsset,
      startAmount: opportunity.startAmount,
      finalAmount: opportunity.finalAmount,
      expectedProfit: opportunity.expectedProfit,
      grossRoiBeforeFees: opportunity.grossRoiBeforeFees,
      grossRoiAfterFees: opportunity.grossRoiAfterFees,
      netRoi: opportunity.netRoi,
      totalFeeRate: opportunity.totalFeeRate,
      totalFeeInStartAsset: opportunity.totalFeeInStartAsset,
      leg1Symbol: opportunity.legs[0].symbol,
      leg1Side: opportunity.legs[0].side,
      leg1FromAsset: opportunity.legs[0].fromAsset,
      leg1ToAsset: opportunity.legs[0].toAsset,
      leg1InputAmount: opportunity.legs[0].inputAmount,
      leg1OutputAmount: opportunity.legs[0].outputAmount,
      leg1Vwap: opportunity.legs[0].vwap,
      leg1FeePaidInOutput: opportunity.legs[0].feePaidInOutput,
      leg1LevelsUsed: opportunity.legs[0].levelsUsed,
      leg2Symbol: opportunity.legs[1].symbol,
      leg2Side: opportunity.legs[1].side,
      leg2FromAsset: opportunity.legs[1].fromAsset,
      leg2ToAsset: opportunity.legs[1].toAsset,
      leg2InputAmount: opportunity.legs[1].inputAmount,
      leg2OutputAmount: opportunity.legs[1].outputAmount,
      leg2Vwap: opportunity.legs[1].vwap,
      leg2FeePaidInOutput: opportunity.legs[1].feePaidInOutput,
      leg2LevelsUsed: opportunity.legs[1].levelsUsed,
      leg3Symbol: opportunity.legs[2].symbol,
      leg3Side: opportunity.legs[2].side,
      leg3FromAsset: opportunity.legs[2].fromAsset,
      leg3ToAsset: opportunity.legs[2].toAsset,
      leg3InputAmount: opportunity.legs[2].inputAmount,
      leg3OutputAmount: opportunity.legs[2].outputAmount,
      leg3Vwap: opportunity.legs[2].vwap,
      leg3FeePaidInOutput: opportunity.legs[2].feePaidInOutput,
      leg3LevelsUsed: opportunity.legs[2].levelsUsed,
      isCrossRoute: triangle?.isCrossRoute ?? false,    // НОВОЕ
      crossAsset: triangle?.crossAsset ?? null          // НОВОЕ
    };

    this.writer.write(record);

    await new Promise<void>((resolve) => {
      this.writer.once('drain', resolve);
    });
  }

  async close(): Promise<void> {
    this.writer.end();

    await new Promise<void>((resolve) => {
      this.stream.once('close', resolve);
    });
  }
}
