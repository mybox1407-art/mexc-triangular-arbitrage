import type { Side, SymbolInfo, Triangle, TriangleLeg } from '../domain/types.js';

interface DirectedEdge {
  fromAsset: string;
  toAsset: string;
  leg: TriangleLeg;
}

export class TriangleBuilder {
  build(symbols: SymbolInfo[], startAsset: string): Triangle[] {
    const edges = this.createEdges(symbols);
    const byFrom = new Map<string, DirectedEdge[]>();

    for (const edge of edges) {
      const current = byFrom.get(edge.fromAsset) ?? [];
      current.push(edge);
      byFrom.set(edge.fromAsset, current);
    }

    const triangles = new Map<string, Triangle>();

    for (const first of byFrom.get(startAsset) ?? []) {
      for (const second of byFrom.get(first.toAsset) ?? []) {
        if (second.toAsset === startAsset) continue;

        for (const third of byFrom.get(second.toAsset) ?? []) {
          if (third.toAsset !== startAsset) continue;

          const legs: [TriangleLeg, TriangleLeg, TriangleLeg] = [
            first.leg,
            second.leg,
            third.leg
          ];

          const id = legs.map((leg) => `${leg.symbol}:${leg.side}`).join('|');

          triangles.set(id, {
            id,
            startAsset,
            middleAsset1: first.toAsset,
            middleAsset2: second.toAsset,
            legs
          });
        }
      }
    }

    return [...triangles.values()];
  }

  private createEdges(symbols: SymbolInfo[]): DirectedEdge[] {
    return symbols.flatMap((symbol) => {
      const buy: DirectedEdge = {
        fromAsset: symbol.quoteAsset,
        toAsset: symbol.baseAsset,
        leg: {
          symbol: symbol.symbol,
          fromAsset: symbol.quoteAsset,
          toAsset: symbol.baseAsset,
          side: 'BUY'
        }
      };

      const sell: DirectedEdge = {
        fromAsset: symbol.baseAsset,
        toAsset: symbol.quoteAsset,
        leg: {
          symbol: symbol.symbol,
          fromAsset: symbol.baseAsset,
          toAsset: symbol.quoteAsset,
          side: 'SELL'
        }
      };

      return [buy, sell];
    });
  }
}
