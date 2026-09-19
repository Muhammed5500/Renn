// x402 v2 scheme binding: "batch-settlement" on "stellar:testnet".
//
// Works with the OFFICIAL x402 packages (@x402/core, @x402/express, @x402/fetch):
//
//   // selling side (service)
//   const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
//     .register(NETWORK, new BatchSettlementStellarServer({ asset: TOKEN }));
//   app.use(paymentMiddleware({ "GET /weather": { accepts: { scheme: SCHEME, network: NETWORK,
//     payTo: ME, price: { asset: TOKEN, amount: "200000" } } } }, server));
//
//   // paying side (agent)
//   const client = new x402Client().register(NETWORK, new BatchSettlementStellarClient(agent));
//   const fetch = wrapFetchWithPayment(globalThis.fetch, client);
//
// The facilitator is the ledger itself (operator/src/server.ts: /supported, /verify, /settle).
//
// Flow "upfront": x402 core calls /settle BEFORE running the handler.
// /settle does not touch the chain; it ACCEPTS the voucher into the ledger
// (the solvency check happens here) and returns the operator's signature.
// Value reaches the chain later, in a batch. The spec allows this explicitly:
// settle "may record the debt", transaction may be ""
// (specs/schemes/batch-settlement/scheme_batch_settlement.md).
//
// Scheme document: docs/scheme_batch_settlement_stellar.md

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

/** Shape of the payment payload (PaymentPayload.payload). */
export type VoucherPayload = {
  type: "voucher";
  voucher: {
    payer: string;
    recipient: string;
    /** cumulative for this pair, 7-decimal integer, as a string */
    cumulative: string;
    /** payer's ed25519 signature, hex, over the "batchv3" payload */
    signature: string;
  };
};

/** "0.02", "$0.02" or 0.02 -> 7-decimal integer. */
export function toAtomic(m: string | number): string {
  const s = String(m).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${m}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) throw new Error(`at most ${DECIMALS} decimals: ${m}`);
  return (BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(frac.padEnd(DECIMALS, "0"))).toString();
}

// ================= selling side (service) =================

export class BatchSettlementStellarServer implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  /** The scheme has no separate asset transfer method. */
  readonly defaultAssetTransferMethod = "default";
  /** Single flow: the payment is accepted into the ledger BEFORE the handler runs. */
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

  /** Adds the vault, ledger and operator info the facilitator announces in /supported to the 402. */
  async enhancePaymentRequirements(
    req: PaymentRequirements,
    kind: SupportedKind,
    _ext: string[],
  ): Promise<PaymentRequirements> {
    return { ...req, extra: { ...(kind.extra ?? {}), ...req.extra } };
  }
}

// ================= paying side (agent) =================

export class BatchSettlementStellarClient implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  agent: Agent;
  constructor(agent: Agent) {
    this.agent = agent;
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = req.extra as { hub?: string; ledger?: string };
    if (extra.hub !== this.agent.hub.hub) {
      throw new Error(`different vault: ${extra.hub}`);
    }
    // The cumulative is computed from the last value the ledger knows, not a
    // local counter: a failed payment must not push the counter ahead and overpay.
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
