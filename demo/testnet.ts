// Testnet helpers for the demo and e2e scripts.
// Fresh agent account: friendbot, token mint, join, deposit.
//
// PAYMENTS ARE REAL x402 v2: each agent's selling endpoint lives on a local
// "market" server (@x402/express paymentMiddleware), and the payer calls it
// with the official client (@x402/fetch). The facilitator is the shadow
// ledger. Vouchers are NOT posted to the ledger directly.

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, TESTNET, A } from "@golge-defter/sdk/chain";
import { Agent } from "@golge-defter/sdk/agent";
import * as P from "@golge-defter/sdk/payload";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSettlementStellarServer, BatchSettlementStellarClient, SCHEME, NETWORK } from "@golge-defter/sdk/x402";

const ROOT = new URL("../", import.meta.url);
export const dep = JSON.parse(readFileSync(new URL("deployments.json", ROOT), "utf8"));
export const LEDGER = process.env.LEDGER_URL ?? "http://localhost:8787";
export const U = 10_000_000n;

/** Token admin (can mint the test token). Stellar CLI identity `deployer`. */
const deployer = Keypair.fromSecret(execSync("stellar keys show deployer").toString().trim());

export const chain = new Chain({ ...TESTNET, hub: dep.hub, token: dep.token }, deployer.publicKey());
export const hubCfg: P.HubCfg = { networkId: P.networkId(TESTNET.passphrase), hub: dep.hub };

/** deployer transactions ONE AT A TIME: parallel transactions from one account get the same sequence number. */
let deployerQueue: Promise<unknown> = Promise.resolve();
function asDeployer<T>(fn: () => Promise<T>): Promise<T> {
  const p = deployerQueue.then(fn, fn);
  deployerQueue = p.catch(() => undefined);
  return p;
}

export const fmt = (n: bigint | string) => (Number(BigInt(n)) / 1e7).toFixed(2);

export type TestAgent = {
  name: string;
  kp: Keypair;
  agent: Agent;
  address: string;
  /** fetch that pays over x402 (official client + our scheme). */
  fetch: typeof fetch;
};

// ================= x402 market =================

export const MARKET = process.env.MARKET_URL ?? "http://localhost:8792";
let market: http.Server | null = null;

/**
 * One selling endpoint per agent: GET /svc/<recipient>?amount=<integer, 7 decimals>.
 * Recipient and price come from the request (x402's DynamicPayTo / DynamicPrice).
 */
export function startMarket() {
  if (market) return;
  const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER })).register(
    NETWORK,
    new BatchSettlementStellarServer({ asset: dep.token }),
  );
  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /svc/:to": {
          accepts: {
            scheme: SCHEME,
            network: NETWORK,
            payTo: (ctx) => ctx.path.split("/")[2],
            price: (ctx) => ({ asset: dep.token, amount: String(ctx.adapter.getQueryParam?.("amount") ?? "0") }),
          },
          description: "agent service",
        },
      },
      rs,
    ),
  );
  app.get("/svc/:to", (req, res) => res.json({ ok: true, to: req.params.to }));
  market = app.listen(Number(new URL(MARKET).port));
}

const unb64 = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString()) : null);

export type PayResult = { status: "accepted"; seq: number } | { status: "refused"; reason: string };

/** `from` pays `amount` by calling `to`'s selling endpoint over x402. */
export async function pay(from: TestAgent, to: string, amount: bigint): Promise<PayResult> {
  startMarket();
  try {
    const r = await from.fetch(`${MARKET}/svc/${to}?amount=${amount}`);
    if (r.status === 200) return { status: "accepted", seq: unb64(r.headers.get("payment-response"))?.extra?.seq };
    // A failed settle's reason is in x402's PAYMENT-RESPONSE header (success:false)
    const sr = unb64(r.headers.get("payment-response"));
    const pr = unb64(r.headers.get("payment-required"));
    return { status: "refused", reason: sr?.errorReason ?? pr?.error ?? `http_${r.status}` };
  } catch (e) {
    return { status: "refused", reason: (e as Error).message };
  }
}

async function fund(g: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${g}`);
  if (!r.ok) throw new Error(`friendbot ${g}: ${r.status}`);
}

/** Fresh agent, joined and funded. join=false makes a pure recipient. */
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
    await mint(kp.publicKey(), deposit);
    await chain.invoke(kp, "deposit", [A.addr(kp.publicKey()), A.i128(deposit)]);
  }
  return asTestAgent(name, kp, agent);
}

/** Mint the test token (through the deployer queue). */
export function mint(to: string, amount: bigint) {
  return asDeployer(() => chain.invoke(deployer, "mint", [A.addr(to), A.i128(amount)], dep.token));
}

/** Agent that pays over x402, from an existing account and voucher key. */
export function asTestAgent(name: string, kp: Keypair, agent: Agent): TestAgent {
  const client = new x402Client()
    .register(NETWORK, new BatchSettlementStellarClient(agent))
    // no per-request cap on this token for demo agents
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token }] });
  return { name, kp, agent, address: kp.publicKey(), fetch: wrapFetchWithPayment(fetch, client) };
}

/** Ask the ledger to refresh these addresses from chain without waiting for events. */
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
  return (await (await fetch(`${LEDGER}/flush`, { method: "POST" })).json()) as any;
}

/** Operator-approved withdrawal: get the ledger's approval, withdraw with your own signature. */
export async function withdrawApproved(a: TestAgent, amount: bigint) {
  // The request is signed with the agent's voucher key (the ledger checks the owner)
  const nonce = await chain.withdrawNonceOf(a.address);
  const sig = P.signHex(a.agent.key, P.withdrawRequestHash(hubCfg, a.address, amount, nonce));
  const r = await fetch(`${LEDGER}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: a.address, amount: amount.toString(), nonce: nonce.toString(), sig }),
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
