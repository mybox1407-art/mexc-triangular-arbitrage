import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export type MexcDepthDelta = {
  symbol: string;
  fromVersion: number;
  toVersion: number;
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
      path.join(protoDir, 'PublicAggreDepthsV3Api.proto')
    ]);

    root.resolveAll();

    const wrapperType = root.lookupType('PushDataV3ApiWrapper');

    return new MexcProtoDecoder(wrapperType);
  }

  decodeAggreDepth(buffer: Buffer): MexcDepthDelta | null {
    const wrapper = this.wrapperType.decode(buffer) as any;

    const symbol = String(wrapper.symbol ?? '').toUpperCase();
    const depth = wrapper.publicAggreDepths;

    if (!symbol || !depth) {
      return null;
    }

    const bids = (depth.bids ?? []).map((item: any) => [
      String(item.price ?? ''),
      String(item.quantity ?? '')
    ]) as [string, string][];

    const asks = (depth.asks ?? []).map((item: any) => [
      String(item.price ?? ''),
      String(item.quantity ?? '')
    ]) as [string, string][];

    const fromVersion = Number(depth.fromVersion ?? 0);
    const toVersion = Number(depth.toVersion ?? 0);

    if (!Number.isFinite(toVersion) || toVersion <= 0) {
      return null;
    }

    return {
      symbol,
      fromVersion,
      toVersion,
      bids,
      asks
    };
  }
}
