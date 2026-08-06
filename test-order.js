import crypto from 'crypto';
import { config } from './src/config.js';

const apiKey = config.mexc.apiKey;
const apiSecret = config.mexc.apiSecret;

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
    quantity: '0.0001',
    timestamp,
    recvWindow: 5000
  };

  const signature = signRequest(requestBody);

  const queryString = Object.entries(requestBody)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const url = `${config.mexc.restUrl}/api/v3/order?${queryString}&signature=${signature}`;

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
