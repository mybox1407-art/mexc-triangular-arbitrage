import WebSocket from 'ws';
import { config } from '../config.js';

export type DepthHandler = (message: {
  symbol: string;
  fromVersion: number;
  toVersion: number;
  bids: [string, string][];
  asks: [string, string][];
}) => void;

export class MexcPublicWs {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly symbols: string[],
    private readonly onDepth: DepthHandler,
    private readonly onOpen?: () => void,
    private readonly onClose?: () => void
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private open(): void {
    this.ws = new WebSocket(config.mexc.wsUrl);

    this.ws.on('open', () => {
      this.subscribeDepth();
      this.startPing();
      this.onOpen?.();
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', () => {
      clearInterval(this.pingTimer);
      this.onClose?.();

      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.open(), 1_500);
      }
    });

    this.ws.on('error', () => {
      this.ws?.close();
    });
  }

  private subscribeDepth(): void {
    for (const symbol of this.symbols) {
      this.send({
        method: 'SUBSCRIPTION',
        params: [`spot@public.aggre.depth.v3.api.pb@100ms@${symbol}`]
      });
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ method: 'PING' });
    }, 20_000);
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(raw: string): void {
    let payload: any;

    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const depth = payload?.d?.publicAggreDepths ?? payload?.publicAggreDepths;
    const symbol = payload?.s ?? payload?.symbol;

    if (!depth || !symbol) return;

    const bids = (depth.bids ?? []).map((item: any) => [
      String(item.price ?? item[0]),
      String(item.quantity ?? item[1])
    ]) as [string, string][];

    const asks = (depth.asks ?? []).map((item: any) => [
      String(item.price ?? item[0]),
      String(item.quantity ?? item[1])
    ]) as [string, string][];

    this.onDepth({
      symbol,
      fromVersion: Number(depth.fromVersion),
      toVersion: Number(depth.toVersion),
      bids,
      asks
    });
  }
}
