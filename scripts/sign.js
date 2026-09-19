#!/usr/bin/env node
// Minimal ed25519 signing helper. NO npm dependencies, only Node's own crypto.
//
// This is not the SDK. The SDK (STEP 14) produces the payload ITSELF and
// compares it byte for byte with the contract's preimage(). Here we read the
// payload from the contract, so we test "is the on-chain side correct", not
// "are both sides the same".
//
// Usage:
//   node sign.js pubkey <seed-hex-32-bytes>
//   node sign.js sign   <seed-hex-32-bytes> <message-hex>

const crypto = require("crypto");

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function pubkeyHex(seedHex) {
  const spki = crypto
    .createPublicKey(privFromSeed(seedHex))
    .export({ format: "der", type: "spki" });
  if (!spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new Error("unexpected SPKI prefix");
  }
  return spki.subarray(SPKI_PREFIX.length).toString("hex");
}

function signHex(seedHex, msgHex) {
  const msg = Buffer.from(msgHex, "hex");
  return crypto.sign(null, msg, privFromSeed(seedHex)).toString("hex");
}

const [cmd, seed, msg] = process.argv.slice(2);
if (cmd === "pubkey") {
  process.stdout.write(pubkeyHex(seed));
} else if (cmd === "sign") {
  process.stdout.write(signHex(seed, msg));
} else {
  console.error("usage: sign.js pubkey <seed-hex> | sign <seed-hex> <msg-hex>");
  process.exit(1);
}
