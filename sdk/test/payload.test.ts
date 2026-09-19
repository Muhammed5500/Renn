// Step D1 - byte parity. Reference: the *_preimage functions of the live
// testnet contract (fixtures/preimages.json). Don't move on to the server until this passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  networkId,
  voucherPreimage,
  acceptPreimage,
  withdrawPreimage,
  voucherHash,
  acceptHash,
  keyFromSeed,
  pubHex,
  signHex,
  verifyHex,
  type HubCfg,
} from "../src/payload.ts";

const fx = JSON.parse(readFileSync(new URL("../fixtures/preimages.json", import.meta.url), "utf8"));
const cfg: HubCfg = { networkId: networkId(fx.passphrase), hub: fx.hub };

test("voucher payload is byte-identical to the contract (including the i128 high half)", () => {
  const v = fx.voucher;
  const got = voucherPreimage(cfg, v.payer, v.recipient, BigInt(v.cumulative));
  assert.equal(got.toString("hex"), v.preimage);
  assert.equal(voucherHash(cfg, v.payer, v.recipient, BigInt(v.cumulative)).toString("hex"), v.hash);
});

test("acceptance payload is byte-identical to the contract (recipient is a C address)", () => {
  const a = fx.accept;
  const got = acceptPreimage(cfg, a.payer, a.recipient, BigInt(a.cumulative));
  assert.equal(got.toString("hex"), a.preimage);
});

test("withdrawal payload is byte-identical to the contract", () => {
  const w = fx.withdraw;
  const got = withdrawPreimage(cfg, w.who, BigInt(w.amount), BigInt(w.nonce), w.valid_until);
  assert.equal(got.toString("hex"), w.preimage);
});

test("voucher and acceptance payloads differ (domain separator)", () => {
  const v = fx.voucher;
  assert.notEqual(
    voucherHash(cfg, v.payer, v.recipient, 5n).toString("hex"),
    acceptHash(cfg, v.payer, v.recipient, 5n).toString("hex"),
  );
});

test("signature round trip, same public key as sign.js", () => {
  const seed = "11".repeat(32);
  const k = keyFromSeed(seed);
  // scripts/sign.js produces this for the same seed (Node crypto, ed25519)
  assert.equal(pubHex(k), "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737");
  const h = voucherHash(cfg, fx.voucher.payer, fx.voucher.recipient, 7n);
  const sig = signHex(k, h);
  assert.ok(verifyHex(pubHex(k), h, sig));
  assert.ok(!verifyHex(pubHex(k), acceptHash(cfg, fx.voucher.payer, fx.voucher.recipient, 7n), sig));
  assert.ok(!verifyHex("00".repeat(32), h, sig));
  assert.ok(!verifyHex("broken", h, sig));
});
