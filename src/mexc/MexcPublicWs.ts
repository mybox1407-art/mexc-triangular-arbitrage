import WebSocket from 'ws';
import { config } from '../config.js';

export type DepthHandler = (message: {
  symbol: string;
  fromVersion: number;
  toVersion: number;
  bids: [string, string][];
  asks: [string, string][];
}) => void | Promise<void>;

type WsConnection = {
  ws: WebSocket;
  pingTimer?: NodeJS.Timeout;
};

const MAX_SUBSCRIPTIONS_PER_SOCKET = 30;
const RECONNECT_DELAY_MS = 1_500;
const PING_INTERVAL_MS = 20_000;

export class MexcPublicWs {
  private readonly connections: WsConnection[] = [];
  private stopped = false;
  private receivedMessages = 0;
  private depthMessages = 0;

  constructor(
    private readonly symbols: string[],
    private readonly onDepth: DepthHandler,
    private readonly onOpen?: () => void,
    private readonly onClose?: () => void
  ) {}

  connect(): void {
    this.stopped = false;

    for (const group of this.chunk(this.symbols, MAX_SUBSCRIPTIONS_PER_SOCKET)) {
      this.open(group);
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
    const connection: WsConnection = { ws };

    this.connections.push(connection);

    ws.on('open', () => {
      this.subscribeDepth(connection, symbols);
      this.startPing(connection);

      console.log(JSON.stringify({
        msg: 'MEXC WebSocket connection opened',
        symbols: symbols.length,
        sampleSymbols: symbols.slice(0, 5)
      }));

      this.onOpen?.();
    });

    ws.on('message', (raw, isBinary) => {
      this.receivedMessages += 1;

      if (isBinary) {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw).length
          : raw instanceof ArrayBuffer
            ? raw.byteLength
            : raw.length;

        console.warn(JSON.stringify({
          msg: 'Unexpected binary MEXC WS message on JSON topic',
          bytes
        }));

        return;
      }

      this.handleMessage(raw.toString());
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
        setTimeout(() => this.open(symbols), RECONNECT_DELAY_MS);
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

  private subscribeDepth(connection: WsConnection, symbols: string[]): void {
    for (const symbol of symbols) {
      this.send(connection.ws, {
        method: 'SUBSCRIPTION',
        params: [
          `spot@public.aggre.depth.v3.api@100ms@${symbol.toUpperCase()}`
        ]
      });
    }

    console.log(JSON.stringify({
      msg: 'MEXC depth subscriptions sent',
      count: symbols.length,
      sampleTopics: symbols.slice(0, 5).map(
        (symbol) =>
          `spot@public.aggre.depth.v3.api@100ms@${symbol.toUpperCase()}`
      )
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

  private handleMessage(raw: string): void {
    let payload: any;

    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn(JSON.stringify({
        msg: 'Cannot parse MEXC WebSocket JSON message',
        preview: raw.slice(0, 300)
      }));
      return;
    }

    const depth =
      payload?.d?.publicAggreDepths ??
      payload?.publicAggreDepths;

    const symbol = String(
      payload?.s ??
      payload?.symbol ??
      ''
    ).toUpperCase();

    if (!depth || !symbol) {
      return;
    }

    const bids = (depth.bids ?? []).map((item: any) => [
      String(item.price ?? item[0]),
      String(item.quantity ?? item[1])
    ]) as [string, string][];

    const asks = (depth.asks ?? []).map((item: any) => [
      String(item.price ?? item[0]),
      String(item.quantity ?? item[1])
    ]) as [string, string][];

    const fromVersion = Number(
      depth.fromVersion ??
      depth.fromVersionId ??
      depth.version ??
      0
    );

    const toVersion = Number(
      depth.toVersion ??
      depth.toVersionId ??
      depth.version ??
      0
    );

    if (!Number.isFinite(toVersion) || toVersion <= 0) {
      console.warn(JSON.stringify({
        msg: 'MEXC depth message contains no valid version',
        symbol,
        preview: raw.slice(0, 500)
      }));
      return;
    }

    this.depthMessages += 1;

    if (this.depthMessages % 100 === 0) {
      console.log(JSON.stringify({
        msg: 'MEXC depth updates received',
        receivedMessages: this.receivedMessages,
        depthMessages: this.depthMessages,
        symbol,
        fromVersion,
        toVersion,
        bids: bids.length,
        asks: asks.length
      }));
    }

    void Promise.resolve(
      this.onDepth({
        symbol,
        fromVersion,
        toVersion,
        bids,
        asks
      })
    ).catch((error) => {
      console.error(JSON.stringify({
        msg: 'Depth handler failed',
        symbol,
        error: error instanceof Error ? error.message : String(error)
      }));
    });
  }

  private chunk(items: string[], chunkSize: number): string[][] {
    const chunks: string[][] = [];

    for (let index = 0; index < items.length; index += chunkSize) {
      chunks.push(items.slice(index, index + chunkSize));
    }

    return chunks;
  }
}
