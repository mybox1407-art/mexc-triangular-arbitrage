import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export type MexcDepthSnapshot = {
  symbol: string;
  version: number;
  bids: [string, string][];
  asks: [string, string][];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MexcProtoDecoder {
  private constructor(
    private readonly wrapperType: protobuf.Type
  ) {}

  static async create(): Promise<MexcProtoDecoder> {
    const root = new protobuf.Root();

    const protoDir = path.resolve(__dirname, '../../proto');

    await root.load([
      path.join(protoDir, 'PushDataV3ApiWrapper.proto'),
      path.join(protoDir, 'PublicLimitDepthsV3Api.proto')
    ]);

    root.resolveAll();

    return new MexcProtoDecoder(
      root.lookupType('PushDataV3ApiWrapper')
    );
  }

  decodeLimitDepth(raw: Buffer): MexcDepthSnapshot | null {
    const wrapper = this.wrapperType.decode(raw) as any;

    const symbol = String(wrapper.symbol ?? '').toUpperCase();
    const depth = wrapper.publicLimitDepths;

    if (!symbol || !depth) {
      return null;
    }

    const bids = (depth.bids ?? [])
      .map((item: any) => [
        String(item.price ?? ''),
        String(item.quantity ?? '')
      ] as [string, string])
      .filter(([price, quantity]: [string, string]) =>
        Number(price) > 0 && Number(quantity) > 0
      );

    const asks = (depth.asks ?? [])
      .map((item: any) => [
        String(item.price ?? ''),
        String(item.quantity ?? '')
      ] as [string, string])
      .filter(([price, quantity]: [string, string]) =>
        Number(price) > 0 && Number(quantity) > 0
      );

    const version = Number(depth.version ?? 0);

    if (!Number.isFinite(version) || version <= 0) {
      return null;
    }

    return {
      symbol,
      version,
      bids,
      asks
    };
  }
}
