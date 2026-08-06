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

async function testBalance() {
  const timestamp = Date.now();
  const params = { timestamp };
  const signature = signRequest(params);

  const url = `${config.mexc.restUrl}/api/v3/account?timestamp=${timestamp}&signature=${signature}`;

  console.log('URL:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MEXC-APIKEY': apiKey,
      'Content-Type': 'application/json'
    }
  });

  console.log('Status:', response.status);

  const data = await response.json();
  console.log('Balance:', data.balances?.slice(0, 5));
}

testBalance().catch(console.error);
