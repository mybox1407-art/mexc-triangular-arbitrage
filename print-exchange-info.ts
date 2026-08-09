import { MexcRestClient } from '../src/mexc/MexcRestClient.js';

async function main() {
  const rest = new MexcRestClient();
  const info: any = await rest.getExchangeInfo();

  console.log('keys:', Object.keys(info));
  console.log('symbols count:', Array.isArray(info.symbols) ? info.symbols.length : 'no symbols');

  const sample = (info.symbols ?? []).slice(0, 5);
  for (const s of sample) {
    console.log(JSON.stringify({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      filters: s.filters
    }, null, 2));
  }
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
