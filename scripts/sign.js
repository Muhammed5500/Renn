#!/usr/bin/env node
// Minimal ed25519 imza yardimcisi. npm bagimliligi YOK, Node'un kendi crypto'su.
//
// Bu SDK degil. SDK (ADIM 14) yuku KENDISI uretecek ve kontrattaki preimage()
// ile bayt bayt karsilastiracak. Burada yuku kontrattan okuyoruz, yani
// "zincir ici taraf dogru mu" sorusunu test ediyoruz, "iki taraf ayni mi"
// sorusunu degil.
//
// Kullanim:
//   node sign.js pubkey <seed-hex-32-bayt>
//   node sign.js sign   <seed-hex-32-bayt> <mesaj-hex>

const crypto = require("crypto");

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed 32 bayt olmali");
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
    throw new Error("beklenmeyen SPKI on eki");
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
  console.error("kullanim: sign.js pubkey <seed-hex> | sign <seed-hex> <msg-hex>");
  process.exit(1);
}
