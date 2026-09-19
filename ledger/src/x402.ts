// x402 v2 sema baglamasi: "batch-settlement" on "stellar:testnet".
//
// x402'nin RESMI paketleriyle calisir (@x402/core, @x402/express, @x402/fetch):
//
//   // hizmet satan taraf
//   const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
//     .register(NETWORK, new BatchSettlementStellarServer({ asset: TOKEN }));
//   app.use(paymentMiddleware({ "GET /weather": { accepts: { scheme: SCHEME, network: NETWORK,
//     payTo: ME, price: { asset: TOKEN, amount: "200000" } } } }, server));
//
//   // ajan yazan taraf
//   const client = new x402Client().register(NETWORK, new BatchSettlementStellarClient(agent));
//   const fetch = wrapFetchWithPayment(globalThis.fetch, client);
//
// Facilitator golge defterin kendisi (server.ts: /supported, /verify, /settle).
//
// Akis "upfront": x402 cekirdegi isleyiciyi calistirmadan ONCE /settle cagirir.
// /settle zincire gitmez; fisi defterde KABUL EDER (odeme gucu kontrolu burada)
// ve operator imzasini dondurur. Deger daha sonra toplu partide zincire gider.
// Spec buna acikca izin veriyor: settle "borcu kaydedebilir", transaction ""
// olabilir (specs/schemes/batch-settlement/scheme_batch_settlement.md).
//
// Sema dokumani: Proje/docs/scheme_batch_settlement_stellar.md

import type {
  AssetAmount,
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import type { Agent } from "./agent.ts";
import * as P from "./payload.ts";

export const SCHEME = "batch-settlement";
export const NETWORK: Network = "stellar:testnet";
export const DECIMALS = 7;

/** Odeme yukunun sekli (PaymentPayload.payload). */
export type VoucherPayload = {
  type: "voucher";
  voucher: {
    payer: string;
    recipient: string;
    /** bu cift icin kumulatif, 7 ondalikli tam sayi, metin */
    cumulative: string;
    /** odeyenin ed25519 imzasi, hex, "batchv3" yuku uzerinde */
    signature: string;
  };
};

/** "0.02", "$0.02" ya da 0.02 -> 7 ondalikli tam sayi. */
export function toAtomic(m: string | number): string {
  const s = String(m).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`gecersiz tutar: ${m}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) throw new Error(`en fazla ${DECIMALS} ondalik: ${m}`);
  return (BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(frac.padEnd(DECIMALS, "0"))).toString();
}

// ================= hizmet satan taraf =================

export class BatchSettlementStellarServer implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  /** Semanin ayri bir varlik transfer yontemi yok. */
  readonly defaultAssetTransferMethod = "default";
  /** Tek akis: odeme isleyiciden ONCE defterde kabul edilir. */
  readonly paymentFlows = { default: { supported: ["upfront"] as const, default: "upfront" as const } };

  asset: string;
  constructor(o: { asset: string }) {
    this.asset = o.asset;
  }

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object") return price;
    return { asset: this.asset, amount: toAtomic(price) };
  }

  getAssetDecimals(): number {
    return DECIMALS;
  }

  /** Facilitator'in /supported'da ilan ettigi kasa, defter ve operator bilgisini 402'ye ekler. */
  async enhancePaymentRequirements(
    req: PaymentRequirements,
    kind: SupportedKind,
    _ext: string[],
  ): Promise<PaymentRequirements> {
    return { ...req, extra: { ...(kind.extra ?? {}), ...req.extra } };
  }
}

// ================= ajan yazan taraf =================

export class BatchSettlementStellarClient implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  agent: Agent;
  constructor(agent: Agent) {
    this.agent = agent;
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = req.extra as { hub?: string; ledger?: string };
    if (extra.hub !== this.agent.hub.hub) {
      throw new Error(`farkli kasa: ${extra.hub}`);
    }
    // Kumulatif defterin bildigi son degerden hesaplanir, yerel sayactan degil:
    // basarisiz bir odeme yerel sayaci ileri itip fazla odemeye yol acmasin.
    const accepted = await this.agent.sync(req.payTo);
    const cumulative = accepted + BigInt(req.amount);
    const sig = P.signHex(
      this.agent.key,
      P.voucherHash(this.agent.hub, this.agent.address, req.payTo, cumulative),
    );
    const payload: VoucherPayload = {
      type: "voucher",
      voucher: {
        payer: this.agent.address,
        recipient: req.payTo,
        cumulative: cumulative.toString(),
        signature: sig,
      },
    };
    return { x402Version, payload };
  }
}
