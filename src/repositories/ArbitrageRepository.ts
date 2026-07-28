import { Pool } from 'pg';
import type { Opportunity } from '../domain/types.js';

export class ArbitrageRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async saveOpportunity(opportunity: Opportunity): Promise<void> {
    await this.pool.query(
      `
      insert into arb_opportunity (
        detected_at,
        triangle_id,
        start_asset,
        start_amount,
        final_amount,
        gross_roi,
        net_roi,
        expected_profit,
        legs
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        opportunity.detectedAt,
        opportunity.triangleId,
        opportunity.startAsset,
        opportunity.startAmount,
        opportunity.finalAmount,
        opportunity.grossRoi,
        opportunity.netRoi,
        opportunity.expectedProfit,
        JSON.stringify(opportunity.legs)
      ]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
