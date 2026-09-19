// Ajan: fis anahtari ve kimligi. x402 istemci semasi (x402.ts) bunu kullanir.
//
// Fis cift basina KUMULATIF. Kumulatif her odemede defterin bildigi son
// degerden hesaplanir (GET /pair). `cum` sadece o okumanin onbellegi: surec
// cokerse ya da bir odeme basarisiz olursa fazla odeme olmaz.

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

  /** Kayitta kullanilacak ham ed25519 acik anahtar (join'e giden). */
  get commitmentKey(): string {
    return P.pubHex(this.key);
  }

  /** Defterin bildigi son kumulatifi al (yeniden baslatma, ret sonrasi). */
  async sync(recipient: string): Promise<bigint> {
    const r = await fetch(`${this.ledgerUrl}/pair/${this.address}/${recipient}`);
    const j = (await r.json()) as { accepted: string };
    const c = BigInt(j.accepted);
    this.cum.set(recipient, c);
    return c;
  }

  /** Onbellekteki kumulatif uzerinden imzali fis. Sadece olcum scripti (limits.ts) kullanir. */
  voucher(recipient: string, amount: bigint) {
    const cumulative = (this.cum.get(recipient) ?? 0n) + amount;
    const sig = P.signHex(this.key, P.voucherHash(this.hub, this.address, recipient, cumulative));
    return { payer: this.address, recipient, cumulative: cumulative.toString(), sig };
  }
}
