// Each agent keeps its Stellar keypair and its voucher seed in state/, so a
// restart keeps the same address and the same vault balance.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { Agent, Chain, TESTNET, A, payload } from "rennpay";

const HERE = new URL("./", import.meta.url);
const STATE = fileURLToPath(new URL("state/", HERE));
const DEPLOYMENTS = fileURLToPath(new URL("../../deployments.json", HERE));

export const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as { hub: string; token: string };
export const LEDGER = process.env.LEDGER_URL ?? "http://localhost:8787";
export const U = 10_000_000n;
export const hubCfg = { networkId: payload.networkId(TESTNET.passphrase), hub: dep.hub };
export const fmt = (n: bigint) => (Number(n) / 1e7).toFixed(2);

type Saved = { secret: string; seedHex: string };

function load(id: string): Saved {
  mkdirSync(STATE, { recursive: true });
  const file = `${STATE}${id}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Saved;
  const saved: Saved = { secret: Keypair.random().secret(), seedHex: randomBytes(32).toString("hex") };
  writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
  return saved;
}

async function funded(address: string) {
  const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  if (r.ok) return;
  const f = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  if (!f.ok) throw new Error(`friendbot ${address}: ${f.status}`);
}

/**
 * Wallet, vault membership and a deposit, all idempotent. Tokens come from the
 * test token's admin, the Stellar CLI identity `deployer`; on a real network
 * this is the part the agent's owner does by itself.
 */
export async function setup(id: string, deposit: bigint) {
  const saved = load(id);
  const kp = Keypair.fromSecret(saved.secret);
  const chain = new Chain({ ...TESTNET, hub: dep.hub, token: dep.token }, kp.publicKey());
  const agent = new Agent({ address: kp.publicKey(), seedHex: saved.seedHex, ledgerUrl: LEDGER, hub: hubCfg });

  await funded(kp.publicKey());
  if (!(await chain.signerOf(kp.publicKey()))) {
    await chain.invoke(kp, "join", [A.addr(kp.publicKey()), A.bytes(agent.commitmentKey)]);
  }
  // Only top up when the vault balance is nearly gone, so a restart does not
  // keep stacking deposits on top of what the agent already holds.
  if ((await chain.balanceOf(kp.publicKey())) < deposit / 5n) {
    execSync(
      `stellar contract invoke --id ${dep.token} --source deployer --network testnet -- mint --to ${kp.publicKey()} --amount ${deposit}`,
      { stdio: "ignore" },
    );
    await chain.invoke(kp, "deposit", [A.addr(kp.publicKey()), A.i128(deposit)]);
  }
  return { kp, chain, agent };
}
