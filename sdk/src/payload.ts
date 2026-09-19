// Step D1 - The three signed payloads, BYTE-IDENTICAL to the contract's voucher.rs.
//
//   Voucher    ("batchv3",  network_id, hub, payer, recipient, cumulative)
//   Acceptance ("acceptv1", network_id, hub, payer, recipient, cumulative)
//   Withdrawal ("withdrv1", network_id, hub, who, amount, nonce, valid_until)
//
// Each is sha256( XDR( ScVal::Vec(tuple) ) ), signed with ed25519.
//
// If a signature does not verify, the culprit is almost always a serialization
// difference. Call the contract's `*_preimage` functions and compare the raw
// bytes (test/payload.test.ts does this with frozen vectors).

import { Address, Keypair, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export type HubCfg = {
  /** sha256(network passphrase) */
  networkId: Buffer;
  /** C... address of the vault contract */
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
  // stellar-sdk 17 returns Uint8Array; wrap in Buffer for hex.
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
 * Withdrawal REQUEST (off-chain, only the ledger verifies it). The agent signs
 * it with its own voucher key, so nobody else can reserve its money and freeze
 * it. nonce = the contract's withdraw_nonce_of: if the same request is sent
 * again, no second reservation is made.
 */
export const withdrawRequestHash = (c: HubCfg, who: string, amount: bigint, nonce: bigint) =>
  sha(Buffer.from(`gd-withdraw-request|${c.networkId.toString("hex")}|${c.hub}|${who}|${amount}|${nonce}`));

// ---------- raw ed25519 (the voucher key, not a Stellar account) ----------

export function keyFromSeed(seedHex: string): Keypair {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return Keypair.fromRawEd25519Seed(seed);
}

export function pubHex(k: Keypair): string {
  return Buffer.from(k.rawPublicKey()).toString("hex");
}

/** Sign the HASH, NOT the raw XDR (contract test: signing_raw_xdr_instead_of_hash_fails). */
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
