import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Opportunity, SimulatedLeg } from '../domain/types.js';

const HEADER = [
  'detected_at',
  'triangle_id',
  'start_asset',
  'start_amount',
  'final_amount',
  'gross_roi_before_fees',
  'gross_roi_after_fees',
  'net_roi',
  'total_fee_rate',
  'total_fee_in_start_asset',
  'expected_profit',
  'leg_1',
  'leg_1_input',
  'leg_1_output',
  'leg_1_vwap',
  'leg_1_fee',
  'leg_1_levels',
  'leg_2',
  'leg_2_input',
  'leg_2_output',
  'leg_2_vwap',
  'leg_2_fee',
  'leg_2_levels',
  'leg_3',
  'leg_3_input',
  'leg_3_output',
  'leg_3_vwap',
  'leg_3_fee',
  'leg_3_levels'
].join(',');

function csvValue(value: string | number | null | undefined): string {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function legName(leg: SimulatedLeg): string {
  return `${leg.fromAsset}->${leg.toAsset} (${leg.symbol}:${leg.side})`;
}

function legValues(leg: SimulatedLeg): Array<string | number> {
  return [
    legName(leg),
    leg.inputAmount,
    leg.outputAmount,
    leg.vwap,
    leg.feePaidInOutput,
    leg.levelsUsed
  ];
}

export class CsvOpportunityWriter {
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(opportunity: Opportunity): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureFile();

      const row = [
        opportunity.detectedAt.toISOString(),
        opportunity.triangleId,
        opportunity.startAsset,
        opportunity.startAmount,
        opportunity.finalAmount,
        opportunity.grossRoiBeforeFees,
        opportunity.grossRoiAfterFees,
        opportunity.netRoi,
        opportunity.totalFeeRate,
        opportunity.totalFeeInStartAsset,
        opportunity.expectedProfit,
        ...legValues(opportunity.legs[0]),
        ...legValues(opportunity.legs[1]),
        ...legValues(opportunity.legs[2])
      ]
        .map(csvValue)
        .join(',');

      await appendFile(this.filePath, `${row}\n`, 'utf8');
    });

    return this.writeQueue;
  }

  private async ensureFile(): Promise<void> {
    if (this.initialized) return;

    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const file = await stat(this.filePath);

      if (file.size === 0) {
        await appendFile(this.filePath, `${HEADER}\n`, 'utf8');
      }
    } catch {
      await appendFile(this.filePath, `${HEADER}\n`, 'utf8');
    }

    this.initialized = true;
  }
}
