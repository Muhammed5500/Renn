// Agent: voucher key and identity. The x402 client scheme (x402.ts) uses it.
//
// Vouchers are CUMULATIVE per pair. On every payment the cumulative is
// computed from the last value the ledger knows (GET /pair). `cum` is only a
// cache of that read: if the process crashes or a payment fails, nothing is
// overpaid.

import * as P from "./payload.ts";

export class Agent {
  address: string;
  ledgerUrl: string;
  hub: P.HubCfg;
  key: ReturnType<typeof P.keyFromSeed>;
  cum = new Map<string, bigint>();

  constructor(o: { address: string; seedHex: string; ledgerUrl: string; hub: P.HubCfg }) {
    this.address = o.address;
    this.ledgerUrl = o.ledgerUrl;
    this.hub = o.hub;
    this.key = P.keyFromSeed(o.seedHex);
  }

  /** Raw ed25519 public key registered at join. */
  get commitmentKey(): string {
    return P.pubHex(this.key);
  }

  /** Fetch the last cumulative the ledger knows (after a restart or a refusal). */
  async sync(recipient: string): Promise<bigint> {
    const r = await fetch(`${this.ledgerUrl}/pair/${this.address}/${recipient}`);
    const j = (await r.json()) as { accepted: string };
    const c = BigInt(j.accepted);
    this.cum.set(recipient, c);
    return c;
  }

  /** Signed voucher on top of the cached cumulative. Only the measurement script (limits.ts) uses it. */
  voucher(recipient: string, amount: bigint) {
    const cumulative = (this.cum.get(recipient) ?? 0n) + amount;
    const sig = P.signHex(this.key, P.voucherHash(this.hub, this.address, recipient, cumulative));
    return { payer: this.address, recipient, cumulative: cumulative.toString(), sig };
  }
}
