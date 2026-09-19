// Gizli giris, ajan (F) tarafi. F'nin XLM'i yok ve hic olmayacak: hesabini
// relayer sponsorlar, islem ucretlerini relayer oder. F'nin zincirdeki hicbir
// izi, SPP havuzuna yatiran bilinen cuzdana (W) gitmez.
//
// SPP adimi (W -> havuz -> F) resmi SPP CLI ile yapilir, bkz. spp-shim/.

import { randomBytes } from "node:crypto";
import { Contract, Keypair, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import { A, type Chain } from "./chain.ts";
import { Agent } from "./agent.ts";
import * as P from "./payload.ts";
import type { SppCli } from "./spp.ts";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok || j.error) throw new Error(`${url}: ${j.error ?? r.status}`);
  return j;
}

/** F'yi 0 XLM ile ac. Rezervi relayer sponsorlar; F sadece kendi kismini imzalar. */
export async function openSponsored(relayUrl: string, f: Keypair, chain: Chain) {
  const { xdr: x } = await post(`${relayUrl}/relay/account`, { address: f.publicKey() });
  const tx = TransactionBuilder.fromXDR(x, chain.cfg.passphrase);
  tx.sign(f);
  return chain.submit(tx, "hesap ac");
}

/** F'nin kasa islemi (join, deposit), ucreti relayer oder (fee-bump). */
export async function relayedInvoke(relayUrl: string, f: Keypair, chain: Chain, method: string, args: xdr.ScVal[]) {
  const acct = await chain.server.getAccount(f.publicKey());
  let tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: chain.cfg.passphrase })
    .addOperation(new Contract(chain.cfg.hub).call(method, ...args))
    .setTimeout(60)
    .build();
  tx = await chain.server.prepareTransaction(tx);
  tx.sign(f);
  const { hash } = await post(`${relayUrl}/relay/fee-bump`, { xdr: tx.toXDR() });
  // relayer bekleyip dondu; okuma tabanini bu islemin ledger'ina tasimak icin
  const res = await chain.server.getTransaction(hash);
  if ("ledger" in res && res.ledger) chain.observe(res.ledger);
  return { hash };
}

// ================= one call =================

export type PrivateOnboardOpts = {
  /** SPP CLI wrapper (binary, circuits, deployment, relay URL). */
  spp: SppCli;
  /** `stellar keys` alias of the known wallet W that holds the tokens. */
  wallet: string;
  /** Amount in 7-decimal units. Use a round amount: it is public on both sides of the pool. */
  amount: bigint;
  /** Vault chain client (its hub is the vault F joins). */
  chain: Chain;
  /** Operator base URL: x402 facilitator and relayer. */
  ledgerUrl: string;
  /** false: W already deposited earlier (the better choice: time between deposit and withdrawal). */
  deposit?: boolean;
  /** Wait between deposit and withdrawal, ms. Longer means more depositors to hide among. */
  waitMs?: number;
  /** Progress lines. */
  log?: (s: string) => void;
};

/**
 * Private entry in one call: W -> SPP pool -> fresh F -> vault.
 *
 *   1. onboard W in SPP (local keys)
 *   2. W deposits into the pool            (skipped with deposit: false)
 *   3. withdraw to a fresh address F        (relayer is source and fee payer)
 *   4. open F with 0 XLM                    (relayer sponsors the reserve)
 *   5. F joins the vault and deposits       (relayer pays through fee-bump)
 *
 * Returns F's keys and an Agent ready to pay over x402. STORE `secret` and
 * `seedHex`: they are the only way to spend or withdraw F's balance.
 */
export async function privateOnboard(o: PrivateOnboardOpts) {
  const log = o.log ?? (() => {});
  const hub: P.HubCfg = { networkId: P.networkId(o.chain.cfg.passphrase), hub: o.chain.cfg.hub };

  await o.spp.onboard(o.wallet);
  let depositTx: string | undefined;
  if (o.deposit !== false) {
    depositTx = await o.spp.deposit(o.wallet, o.amount);
    log(`deposit into the SPP pool: ${depositTx}`);
  }
  if (o.waitMs) await new Promise((r) => setTimeout(r, o.waitMs));

  const f = Keypair.random();
  const withdrawTx = await o.spp.withdraw(o.wallet, o.amount, f.publicKey());
  log(`withdrawal to fresh F ${f.publicKey()}: ${withdrawTx}`);

  const seedHex = randomBytes(32).toString("hex");
  const agent = new Agent({ address: f.publicKey(), seedHex, ledgerUrl: o.ledgerUrl, hub });
  const opened = await openSponsored(o.ledgerUrl, f, o.chain);
  const joined = await relayedInvoke(o.ledgerUrl, f, o.chain, "join", [A.addr(f.publicKey()), A.bytes(agent.commitmentKey)]);
  const deposited = await relayedInvoke(o.ledgerUrl, f, o.chain, "deposit", [A.addr(f.publicKey()), A.i128(o.amount)]);
  log(`F opened with 0 XLM, joined the vault and deposited (fees paid by the relayer)`);

  return {
    address: f.publicKey(),
    keypair: f,
    secret: f.secret(),
    seedHex,
    agent,
    txs: { sppDeposit: depositTx, sppWithdraw: withdrawTx, openAccount: opened.hash, join: joined.hash, deposit: deposited.hash },
  };
}
