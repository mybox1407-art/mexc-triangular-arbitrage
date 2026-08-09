import { MexcRestClient } from './src/mexc/MexcRestClient.js';

async function main(): Promise<void> {
  const rest = new MexcRestClient();

  const info: any =
    await rest.getExchangeInfo();

  console.log(
    'keys:',
    Object.keys(info)
  );

  console.log(
    'symbols count:',
    Array.isArray(info.symbols)
      ? info.symbols.length
      : 'no symbols'
  );

  const symbolsToCheck = [
    'THEUSDT',
    'THEUSDC',
    'WLDUSDT',
    'WLDUSDC',
    'FILUSDT',
    'FILUSDC',
    'AEVOUSDT',
    'AEVOUSDC'
  ];

  const symbols = Array.isArray(info.symbols)
    ? info.symbols
    : [];

  for (const symbolName of symbolsToCheck) {
    const symbol = symbols.find(
      (item: any) =>
        String(item.symbol ?? '').toUpperCase() ===
        symbolName
    );

    if (!symbol) {
      console.log(
        `\n${symbolName}: NOT FOUND`
      );

      continue;
    }

    console.log(
      `\n===== ${symbolName} =====`
    );

    console.log(
      JSON.stringify(
        {
          symbol: symbol.symbol,
          baseAsset: symbol.baseAsset,
          quoteAsset: symbol.quoteAsset,
          status: symbol.status,

          baseAssetPrecision:
            symbol.baseAssetPrecision,

          baseSizePrecision:
            symbol.baseSizePrecision,

          quotePrecision:
            symbol.quotePrecision,

          quoteAmountPrecision:
            symbol.quoteAmountPrecision,

          quoteAmountPrecisionMarket:
            symbol.quoteAmountPrecisionMarket,

          filters:
            symbol.filters
        },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(
    'FAILED:',
    err instanceof Error
      ? err.message
      : err
  );

  process.exit(1);
});
