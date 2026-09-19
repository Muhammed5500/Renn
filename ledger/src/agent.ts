// Ajan istemcisi: fis imzalar, deftere asar. SDK'nin cekirdegi (ADIM S).
//
// Ajan cift basina KUMULATIF tutar. Her odeme bir oncekinin yerine gecen yeni
// bir fis. Surec cokerse son kabul edilen kumulatifi defterden sorar
// (GET /pair), yerel defterin kaybolmasi sorun degil.

import * as P from "./payload.ts";

export type PayResult =
  | { status: "accepted"; seq: number; op_sig: string; spendable_after: string; cumulative: bigint }
  | { status: "refused"; reason: string };

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

  /** Imzali fis, henuz gonderilmemis. Alici bunu deftere asar. */
  voucher(recipient: string, amount: bigint) {
    const cumulative = (this.cum.get(recipient) ?? 0n) + amount;
    const sig = P.signHex(this.key, P.voucherHash(this.hub, this.address, recipient, cumulative));
    return { payer: this.address, recipient, cumulative: cumulative.toString(), sig };
  }

  /**
   * Ode. ZINCIRE GITMEZ. Fis deftere asilir, defter kabul ederse yerel
   * kumulatif ilerler. Ret halinde kumulatif ilerlemez.
   */
  async pay(recipient: string, amount: bigint): Promise<PayResult> {
    if (!this.cum.has(recipient)) await this.sync(recipient);
    const v = this.voucher(recipient, amount);
    const r = await fetch(`${this.ledgerUrl}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v),
    });
    const j = (await r.json()) as PayResult;
    if (j.status === "accepted") {
      this.cum.set(recipient, BigInt(v.cumulative));
      return { ...j, cumulative: BigInt(v.cumulative) };
    }
    if (j.status === "refused" && j.reason === "stale") await this.sync(recipient);
    return j;
  }
}
