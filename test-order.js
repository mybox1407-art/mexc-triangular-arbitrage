import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Парсинг .env
const envContent = readFileSync(join(__dirname, '.env'), 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    env[key.trim()] = value.trim();
  }
});

const apiKey = env.MEXC_API_KEY;
const apiSecret = env.MEXC_API_SECRET;
const restUrl = env.MEXC_REST_URL || 'https://api.mexc.com';

function signRequest(params) {
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

async function testPlaceOrder() {
  const timestamp = Date.now();
  const requestBody = {
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: '0.00001',
    timestamp,
    recvWindow: 5000
  };

  const signature = signRequest(requestBody);

  const queryString = Object.entries(requestBody)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const url = `${restUrl}/api/v3/order?${queryString}&signature=${signature}`;

  console.log('URL:', url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-MEXC-APIKEY': apiKey,
      'Content-Type': 'application/json'
    }
  });

  console.log('Status:', response.status);

  const data = await response.json();
  console.log('Order:', data);
}

testPlaceOrder().catch(console.error);
