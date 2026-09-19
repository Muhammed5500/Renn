// ADIM D1 - Uc imza yuku, kontrattaki voucher.rs ile BAYT BAYT AYNI.
//
//   Fis   ("batchv3",  network_id, hub, payer, recipient, cumulative)
//   Kabul ("acceptv1", network_id, hub, payer, recipient, cumulative)
//   Cekim ("withdrv1", network_id, hub, who, amount, nonce, valid_until)
//
// Hepsi sha256( XDR( ScVal::Vec(tuple) ) ), uzerinde ed25519.
//
// Imza tutmuyorsa suclu neredeyse her zaman serilestirme farkidir. Kontrattaki
// `*_preimage` fonksiyonlarini cagir, ham baytlari karsilastir
// (test/payload.test.ts bunu dondurulmus vektorlerle yapiyor).

import { Address, Keypair, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export type HubCfg = {
  /** sha256(network passphrase) */
  networkId: Buffer;
  /** kasa kontratinin C... adresi */
  hub: string;
};

export function networkId(passphrase: string): Buffer {
  return Buffer.from(hash(Buffer.from(passphrase)));
}

function pairPreimage(
  domain: string,
  c: HubCfg,
  payer: string,
  recipient: string,
  cumulative: bigint,
): Buffer {
  // stellar-sdk 17 Uint8Array donduruyor; hex icin Buffer'a sar.
  return Buffer.from(xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(domain),
    xdr.ScVal.scvBytes(c.networkId),
    Address.fromString(c.hub).toScVal(),
    Address.fromString(payer).toScVal(),
    Address.fromString(recipient).toScVal(),
    nativeToScVal(cumulative, { type: "i128" }),
  ]).toXDR() as Uint8Array);
}

export function voucherPreimage(c: HubCfg, payer: string, recipient: string, cumulative: bigint): Buffer {
  return pairPreimage("batchv3", c, payer, recipient, cumulative);
}

export function acceptPreimage(c: HubCfg, payer: string, recipient: string, cumulative: bigint): Buffer {
  return pairPreimage("acceptv1", c, payer, recipient, cumulative);
}

export function withdrawPreimage(
  c: HubCfg,
  who: string,
  amount: bigint,
  nonce: bigint,
  validUntil: number,
): Buffer {
  return Buffer.from(xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("withdrv1"),
    xdr.ScVal.scvBytes(c.networkId),
    Address.fromString(c.hub).toScVal(),
    Address.fromString(who).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(nonce, { type: "u64" }),
    nativeToScVal(validUntil, { type: "u32" }),
  ]).toXDR() as Uint8Array);
}

const sha = (b: Buffer): Buffer => Buffer.from(hash(b));

export const voucherHash = (c: HubCfg, p: string, r: string, cum: bigint) =>
  sha(voucherPreimage(c, p, r, cum));
export const acceptHash = (c: HubCfg, p: string, r: string, cum: bigint) =>
  sha(acceptPreimage(c, p, r, cum));
export const withdrawHash = (c: HubCfg, who: string, amount: bigint, nonce: bigint, until: number) =>
  sha(withdrawPreimage(c, who, amount, nonce, until));

/**
 * Cekim ISTEGI (zincir disi, sadece defter dogrular). Ajan kendi fis
 * anahtariyla imzalar; boylece baskasi onun adina para ayirtip parasini
 * donduramaz. nonce = kontrattaki withdraw_nonce_of: ayni istek tekrar
 * gonderilirse ikinci ayirma yapilmaz.
 */
export const withdrawRequestHash = (c: HubCfg, who: string, amount: bigint, nonce: bigint) =>
  sha(Buffer.from(`gd-withdraw-request|${c.networkId.toString("hex")}|${c.hub}|${who}|${amount}|${nonce}`));

// ---------- ham ed25519 (Stellar hesabi degil, fis anahtari) ----------

export function keyFromSeed(seedHex: string): Keypair {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed 32 bayt olmali");
  return Keypair.fromRawEd25519Seed(seed);
}

export function pubHex(k: Keypair): string {
  return Buffer.from(k.rawPublicKey()).toString("hex");
}

/** HASH'i imzala, ham XDR'i DEGIL (kontrat testi: signing_raw_xdr_instead_of_hash_fails). */
export function signHex(k: Keypair, h: Buffer): string {
  return Buffer.from(k.sign(h)).toString("hex");
}

export function verifyHex(pub: string, h: Buffer, sig: string): boolean {
  try {
    const kp = new Keypair({ type: "ed25519", publicKey: Buffer.from(pub, "hex") });
    return kp.verify(h, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}
