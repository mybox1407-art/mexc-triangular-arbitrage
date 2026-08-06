export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class ConfigValidator {
  static validate(config: any): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // MEXC API
    if (!config.mexc.apiKey || config.mexc.apiKey.trim() === '') {
      errors.push('MEXC_API_KEY is empty or not set');
    }

    if (!config.mexc.apiSecret || config.mexc.apiSecret.trim() === '') {
      errors.push('MEXC_API_SECRET is empty or not set');
    }

    // Telegram
    if (!config.telegram.botToken || config.telegram.botToken.trim() === '') {
      errors.push('TELEGRAM_BOT_TOKEN is empty or not set');
    } else if (!config.telegram.botToken.startsWith('Bot')) {
      warnings.push('TELEGRAM_BOT_TOKEN should start with "Bot"');
    }

    if (!config.telegram.chatId || config.telegram.chatId.trim() === '') {
      warnings.push('TELEGRAM_CHAT_ID is empty — Telegram notifications will not work');
    }

    // Trading Config
    if (config.trading.minNetRoi <= 0) {
      errors.push(`MIN_NET_ROI must be positive, got: ${config.trading.minNetRoi}`);
    }

    if (config.trading.startNotional <= 0) {
      errors.push(`START_NOTIONAL must be positive, got: ${config.trading.startNotional}`);
    }

    if (config.trading.maxNotionalPerCycle <= 0) {
      errors.push(`MAX_NOTIONAL_PER_CYCLE must be positive, got: ${config.trading.maxNotionalPerCycle}`);
    }

    if (config.trading.takerFeeRate < 0 || config.trading.takerFeeRate >= 1) {
      errors.push(`TAKER_FEE_RATE must be 0-1, got: ${config.trading.takerFeeRate}`);
    }

    // Symbols
    if (!config.trading.startAsset || config.trading.startAsset.trim() === '') {
      errors.push('START_ASSET is empty or not set');
    }

    if (!Array.isArray(config.trading.crossAssets) || config.trading.crossAssets.length === 0) {
      warnings.push('CROSS_ASSETS is empty — no cross-route arbitrage');
    }

    // Live trading check
    if (config.trading.liveTrading) {
      warnings.push('LIVE_TRADING=true — real orders will be executed!');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  static printResults(result: ValidationResult): void {
    console.log('\n=== CONFIG VALIDATION ===\n');

    if (result.valid) {
      console.log('✅ Configuration is VALID\n');
    } else {
      console.log('❌ Configuration is INVALID\n');
    }

    if (result.errors.length > 0) {
      console.log('ERRORS:');
      result.errors.forEach(err => console.log(`  ❌ ${err}`));
      console.log('');
    }

    if (result.warnings.length > 0) {
      console.log('WARNINGS:');
      result.warnings.forEach(warn => console.log(`  ⚠️  ${warn}`));
      console.log('');
    }

    console.log('========================\n');
  }

  static validateOrThrow(config: any): void {
    const result = this.validate(config);
    this.printResults(result);

    if (!result.valid) {
      throw new Error(`Configuration validation failed:\n${result.errors.join('\n')}`);
    }
  }
}
