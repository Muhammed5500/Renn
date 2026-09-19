// Demo ve e2e scriptleri icin testnet yardimcilari.
// Taze ajan hesabi: friendbot, token mint, join, deposit.
//
// ODEMELER GERCEK x402 v2: her ajanin satis ucu yerel "pazar" sunucusunda
// (@x402/express paymentMiddleware), odeyen resmi istemciyle (@x402/fetch)
// cagiriyor. Facilitator golge defter. Fis dogrudan deftere POSTALANMIYOR.

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, TESTNET, A } from "../src/chain.ts";
import { Agent } from "../src/agent.ts";
import * as P from "../src/payload.ts";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSettlementStellarServer, BatchSettlementStellarClient, SCHEME, NETWORK } from "../src/x402.ts";

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

export type TestAgent = {
  name: string;
  kp: Keypair;
  agent: Agent;
  address: string;
  /** x402 odemeli fetch (resmi istemci + bizim sema). */
  fetch: typeof fetch;
};

// ================= x402 pazari =================

export const MARKET = process.env.MARKET_URL ?? "http://localhost:8792";
let market: http.Server | null = null;

/**
 * Her ajan icin bir satis ucu: GET /svc/<alici>?amount=<7 ondalikli tam sayi>.
 * Alici ve fiyat istekten gelir (x402'nin DynamicPayTo / DynamicPrice'i).
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
          description: "ajan servisi",
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

/** from, to'nun satis ucunu x402 ile cagirarak amount oder. */
export async function pay(from: TestAgent, to: string, amount: bigint): Promise<PayResult> {
  startMarket();
  try {
    const r = await from.fetch(`${MARKET}/svc/${to}?amount=${amount}`);
    if (r.status === 200) return { status: "accepted", seq: unb64(r.headers.get("payment-response"))?.extra?.seq };
    // Basarisiz settle'in sebebi x402'nin PAYMENT-RESPONSE basliginda (success:false)
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
  const client = new x402Client()
    .register(NETWORK, new BatchSettlementStellarClient(agent))
    // demo ajanlari icin bu token'a istek basina ust sinir yok
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token }] });
  return { name, kp, agent, address: kp.publicKey(), fetch: wrapFetchWithPayment(fetch, client) };
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
  return (await (await fetch(`${LEDGER}/flush`, { method: "POST" })).json()) as any;
}

/** Operator onayli cekim: defterden onay al, kendi imzanla cek. */
export async function withdrawApproved(a: TestAgent, amount: bigint) {
  // Istek ajanin fis anahtariyla imzali (defter sahibini dogrular)
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
