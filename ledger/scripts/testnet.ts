// Demo ve e2e scriptleri icin testnet yardimcilari.
// Taze ajan hesabi: friendbot, token mint, join, deposit.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, TESTNET, A } from "../src/chain.ts";
import { Agent } from "../src/agent.ts";
import * as P from "../src/payload.ts";

const ROOT = new URL("../../", import.meta.url);
export const dep = JSON.parse(readFileSync(new URL("deployments.json", ROOT), "utf8"));
export const LEDGER = process.env.LEDGER_URL ?? "http://localhost:8787";
export const U = 10_000_000n;

/** Token admini (test token'i mint edebilen). CLI kimligi `deployer`. */
const deployer = Keypair.fromSecret(execSync("stellar keys show deployer").toString().trim());

export const chain = new Chain({ ...TESTNET, hub: dep.hub, token: dep.token }, deployer.publicKey());
export const hubCfg: P.HubCfg = { networkId: P.networkId(TESTNET.passphrase), hub: dep.hub };

/** deployer'in islemleri SIRAYLA: ayni hesaptan paralel islem ayni sequence'i alir. */
let deployerQueue: Promise<unknown> = Promise.resolve();
function asDeployer<T>(fn: () => Promise<T>): Promise<T> {
  const p = deployerQueue.then(fn, fn);
  deployerQueue = p.catch(() => undefined);
  return p;
}

export const fmt = (n: bigint | string) => (Number(BigInt(n)) / 1e7).toFixed(2);

export type TestAgent = { name: string; kp: Keypair; agent: Agent; address: string };

async function fund(g: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${g}`);
  if (!r.ok) throw new Error(`friendbot ${g}: ${r.status}`);
}

/** Taze, kayitli, yatirmis ajan. join=false ise saf alici. */
export async function newAgent(
  name: string,
  deposit: bigint,
  opts: { join?: boolean } = {},
): Promise<TestAgent> {
  const kp = Keypair.random();
  await fund(kp.publicKey());
  const agent = new Agent({
    address: kp.publicKey(),
    seedHex: randomBytes(32).toString("hex"),
    ledgerUrl: LEDGER,
    hub: hubCfg,
  });
  if (opts.join !== false) {
    await chain.invoke(kp, "join", [A.addr(kp.publicKey()), A.bytes(agent.commitmentKey)]);
  }
  if (deposit > 0n) {
    await asDeployer(() => chain.invoke(deployer, "mint", [A.addr(kp.publicKey()), A.i128(deposit)], dep.token));
    await chain.invoke(kp, "deposit", [A.addr(kp.publicKey()), A.i128(deposit)]);
  }
  return { name, kp, agent, address: kp.publicKey() };
}

/** Defterin bu adresleri olay beklemeden zincirden tazelemesini iste. */
export async function track(addresses: string[], labels: Record<string, string> = {}) {
  await fetch(`${LEDGER}/track`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses, labels }),
  });
}

export async function ledgerState() {
  return (await (await fetch(`${LEDGER}/state`)).json()) as any;
}

export async function settleNow() {
  return (await (await fetch(`${LEDGER}/settle`, { method: "POST" })).json()) as any;
}

/** Operator onayli cekim: defterden onay al, kendi imzanla cek. */
export async function withdrawApproved(a: TestAgent, amount: bigint) {
  const r = await fetch(`${LEDGER}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: a.address, amount: amount.toString() }),
  });
  const j = (await r.json()) as any;
  if (j.status !== "approved") return j;
  const res = await chain.invoke(a.kp, "withdraw_approved", [
    A.addr(a.address),
    A.i128(BigInt(j.amount)),
    A.u32(j.valid_until),
    A.bytes(j.op_sig),
  ]);
  return { ...j, hash: res.hash };
}
