import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Opportunity, SimulatedLeg, Triangle } from '../domain/types.js';

const HEADER = [
  'observed_at',
  'triangle_id',
  'start_asset',
  'start_amount',
  'final_amount',
  'gross_roi_before_fees',
  'gross_roi_after_fees',
  'gross_roi_after_fees_pct',
  'net_roi',
  'net_roi_pct',
  'total_fee_rate',
  'total_fee_in_start_asset',
  'expected_profit',
  'max_levels_used',
  'leg_1_route',
  'leg_1_symbol',
  'leg_1_side',
  'leg_1_input',
  'leg_1_output',
  'leg_1_vwap',
  'leg_1_fee',
  'leg_1_levels',
  'leg_2_route',
  'leg_2_symbol',
  'leg_2_side',
  'leg_2_input',
  'leg_2_output',
  'leg_2_vwap',
  'leg_2_fee',
  'leg_2_levels',
  'leg_3_route',
  'leg_3_symbol',
  'leg_3_side',
  'leg_3_input',
  'leg_3_output',
  'leg_3_vwap',
  'leg_3_fee',
  'leg_3_levels',
  'is_cross_route',
  'cross_asset'
].join(',');

function csvValue(value: string | number | null | undefined | boolean): string {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function legValues(leg: SimulatedLeg): Array<string | number> {
  return [
    `${leg.fromAsset}->${leg.toAsset}`,
    leg.symbol,
    leg.side,
    leg.inputAmount,
    leg.outputAmount,
    leg.vwap,
    leg.feePaidInOutput,
    leg.levelsUsed
  ];
}

export class CsvBestRouteWriter {
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(
    opportunity: Opportunity,
    triangle?: Triangle
  ): Promise<void> {
    // Записываем только положительные возможности
    if (opportunity.expectedProfit <= 0) {
      return;
    }

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
        opportunity.grossRoiAfterFees * 100,
        opportunity.netRoi,
        opportunity.netRoi * 100,
        opportunity.totalFeeRate,
        opportunity.totalFeeInStartAsset,
        opportunity.expectedProfit,
        Math.max(...opportunity.legs.map(leg => leg.levelsUsed)),
        ...legValues(opportunity.legs[0]),
        ...legValues(opportunity.legs[1]),
        ...legValues(opportunity.legs[2]),
        triangle?.isCrossRoute ?? false,
        triangle?.crossAsset ?? null
      ]
        .map(csvValue)
        .join(',');

      await appendFile(this.filePath, `${row}\n`, 'utf8');
    });

    return this.writeQueue;
  }

  private async ensureFile(): Promise<void> {
    if (this.initialized) {
      return;
    }

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
