import WebSocket from 'ws';
import { config } from '../config.js';
import { MexcProtoDecoder } from './MexcProtoDecoder.js';

export type DepthHandler = (message: {
  symbol: string;
  fromVersion: number;
  toVersion: number;
  bids: [string, string][];
  asks: [string, string][];
}) => void | Promise<void>;

type WsConnection = {
  ws: WebSocket;
  symbols: string[];
  pingTimer?: NodeJS.Timeout;
};

const MAX_SUBSCRIPTIONS_PER_SOCKET = 30;
const INITIAL_RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 20_000;
const LIMIT_DEPTH_LEVELS = 5;

export class MexcPublicWs {
  private readonly connections: WsConnection[] = [];
  private decoder?: MexcProtoDecoder;
  private stopped = false;
  private receivedMessages = 0;
  private decodedDepthMessages = 0;
  private reconnectAttempts = new Map<string, number>();

  constructor(
    private readonly symbols: string[],
    private readonly onDepth: DepthHandler,
    private readonly onOpen?: () => void,
    private readonly onClose?: () => void
  ) {}

  async connect(): Promise<void> {
    this.stopped = false;
    this.decoder = await MexcProtoDecoder.create();

    for (const symbols of this.chunk(this.symbols, MAX_SUBSCRIPTIONS_PER_SOCKET)) {
      this.open(symbols);
    }
  }

  stop(): void {
    this.stopped = true;

    for (const connection of this.connections) {
      clearInterval(connection.pingTimer);

      if (
        connection.ws.readyState === WebSocket.OPEN ||
        connection.ws.readyState === WebSocket.CONNECTING
      ) {
        connection.ws.close();
      }
    }

    this.connections.length = 0;
  }

  private open(symbols: string[]): void {
    const ws = new WebSocket(config.mexc.wsUrl);
    const connectionKey = symbols.join(',');
    const connection: WsConnection = { ws, symbols };

    this.connections.push(connection);

    ws.on('open', () => {
      this.reconnectAttempts.set(connectionKey, 0);
      
      this.subscribeLimitDepth(connection);
      this.startPing(connection);

      //console.log(JSON.stringify({
      //  msg: 'MEXC limit-depth WebSocket connection opened',
      //  symbols: symbols.length,
      //  sampleSymbols: symbols.slice(0, 5)
      //}));

      this.onOpen?.();
    });

    ws.on('message', (raw, isBinary) => {
      this.receivedMessages += 1;

      if (!isBinary) {
        this.handleTextMessage(raw.toString());
        return;
      }

      this.handleBinaryMessage(raw);
    });

    ws.on('close', (code, reason) => {
      clearInterval(connection.pingTimer);

      const index = this.connections.indexOf(connection);
      if (index >= 0) {
        this.connections.splice(index, 1);
      }

      console.warn(JSON.stringify({
        msg: 'MEXC WebSocket connection closed',
        code,
        reason: reason.toString(),
        symbols: symbols.length
      }));

      this.onClose?.();

      if (!this.stopped) {
        const attempts = this.reconnectAttempts.get(connectionKey) || 0;
        const nextAttempts = attempts + 1;
        this.reconnectAttempts.set(connectionKey, nextAttempts);
        
        const delay = Math.min(
          INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempts),
          MAX_RECONNECT_DELAY_MS
        );
        
        console.log(JSON.stringify({
          msg: 'MEXC WebSocket reconnect scheduled',
          attempt: nextAttempts,
          delayMs: delay
        }));
        
        setTimeout(() => this.open(symbols), delay);
      }
    });

    ws.on('error', (error) => {
      console.error(JSON.stringify({
        msg: 'MEXC WebSocket error',
        error: error.message,
        symbols: symbols.length
      }));

      ws.close();
    });
  }

  private subscribeLimitDepth(connection: WsConnection): void {
    const params = connection.symbols.map(
      (symbol) =>
        `spot@public.limit.depth.v3.api.pb@${symbol.toUpperCase()}@${LIMIT_DEPTH_LEVELS}`
    );

    this.send(connection.ws, {
      method: 'SUBSCRIPTION',
      params
    });

    console.log(JSON.stringify({
      msg: 'MEXC protobuf limit-depth subscriptions sent',
      count: params.length,
      sampleTopics: params.slice(0, 5)
    }));
  }

  private startPing(connection: WsConnection): void {
    connection.pingTimer = setInterval(() => {
      this.send(connection.ws, { method: 'PING' });
    }, PING_INTERVAL_MS);
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private handleTextMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw);

      if (payload?.code !== undefined && payload.code !== 0) {
        console.error(JSON.stringify({
          msg: 'MEXC WebSocket subscription error',
          payload
        }));
      }
    } catch {
      console.warn(JSON.stringify({
        msg: 'MEXC WebSocket unknown text message',
        preview: raw.slice(0, 300)
      }));
    }
  }

  private handleBinaryMessage(raw: WebSocket.RawData): void {
    if (!this.decoder) {
      return;
    }

    const buffer = this.toBuffer(raw);

    try {
      const snapshot = this.decoder.decodeLimitDepth(buffer);

      if (!snapshot) {
        return;
      }

      this.decodedDepthMessages += 1;

      //if (this.decodedDepthMessages % 100 === 0) {
      //  console.log(JSON.stringify({
      //    msg: 'MEXC protobuf limit-depth snapshots decoded',
      //    receivedMessages: this.receivedMessages,
      //    decodedDepthMessages: this.decodedDepthMessages,
      //    symbol: snapshot.symbol,
      //    version: snapshot.version,
      //    bids: snapshot.bids.length,
      //    asks: snapshot.asks.length
      //  }));
      //}

      void Promise.resolve(
        this.onDepth({
          symbol: snapshot.symbol,
          fromVersion: snapshot.version,
          toVersion: snapshot.version,
          bids: snapshot.bids,
          asks: snapshot.asks
        })
      ).catch((error) => {
        console.error(JSON.stringify({
          msg: 'MEXC limit-depth handler failed',
          symbol: snapshot.symbol,
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    } catch (error) {
      console.error(JSON.stringify({
        msg: 'Cannot decode MEXC protobuf limit-depth message',
        error: error instanceof Error ? error.message : String(error),
        bytes: buffer.length,
        preview: buffer.subarray(0, 32).toString('hex')
      }));
    }
  }

  private toBuffer(raw: WebSocket.RawData): Buffer {
    if (Array.isArray(raw)) {
      return Buffer.concat(raw);
    }

    if (raw instanceof ArrayBuffer) {
      return Buffer.from(raw);
    }

    return raw;
  }

  private chunk(items: string[], chunkSize: number): string[][] {
    const chunks: string[][] = [];

    for (let index = 0; index < items.length; index += chunkSize) {
      chunks.push(items.slice(index, index + chunkSize));
    }

    return chunks;
  }
}
