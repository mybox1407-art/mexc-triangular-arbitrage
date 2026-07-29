import WebSocket from 'ws';

const ws = new WebSocket('wss://wbs-api.mexc.com/ws');

ws.on('open', () => {
  console.log('OPEN');

  ws.send(JSON.stringify({
    method: 'SUBSCRIPTION',
    params: [
      'spot@public.limit.depth.v3.api.pb@BTCUSDT@5'
    ]
  }));

  console.log('SUBSCRIPTION SENT');
});

ws.on('message', (raw, isBinary) => {
  const bytes = Array.isArray(raw)
    ? Buffer.concat(raw).length
    : raw instanceof ArrayBuffer
      ? raw.byteLength
      : raw.length;

  if (isBinary) {
    console.log('BINARY MESSAGE', {
      bytes,
      hexPreview: Buffer.from(
        Array.isArray(raw) ? Buffer.concat(raw) : raw
      ).subarray(0, 32).toString('hex')
    });

    return;
  }

  console.log('JSON MESSAGE', raw.toString().slice(0, 1000));
});

ws.on('close', (code, reason) => {
  console.log('CLOSE', {
    code,
    reason: reason.toString()
  });

  process.exit(code === 1000 ? 0 : 1);
});

ws.on('error', (error) => {
  console.error('ERROR', error.message);
});

setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'PING' }));
    console.log('PING');
  }
}, 20_000);
