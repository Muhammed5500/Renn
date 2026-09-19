// Private entry (SPP), on testnet. With the ledger running with RELAYER_SECRET:
//   node demo/check-private.ts        (SPP CLI and circuits under spp/, see spp.ts)
//
// Three known wallets (W1, W2, W3) deposit 10 each into the SPP pool. One of
// them withdraws 10 to a fresh F. Thanks to the relayer, F opens an account
// with 0 XLM, joins the vault, deposits and pays over x402.
//
// Checks:
//   1. NONE of F's transactions, withdrawal included, contains W1/W2/W3 (byte scan)
//   2. F holds 0 XLM; the account reserve is sponsored by the relayer
//   3. F is a normal agent in the vault: its x402 payment is accepted
//   4. The relayer signs only its own narrow transaction shapes
import { Asset, TransactionBuilder, Contract, xdr, nativeToScVal, Operation, type Account } from "@stellar/stellar-sdk";
import { chain, dep, fmt, U, newAgent, pay, track, LEDGER } from "./testnet.ts";
import { A } from "rennpay/chain";
import { privateEntry, addressesIn } from "./spp.ts";

const must = (c: boolean, m: string) => {
  if (!c) {
    console.error("ERROR:", m);
    process.exit(1);
  }
};
const relay = (await fetch(`${LEDGER}/relay/info`).then((r) => r.json())) as { address: string };
must(!!relay.address, "relayer is off in the ledger (RELAYER_SECRET)");

console.log("1) private entry: W1, W2 deposit into the pool; W3 goes W3 -> pool -> F -> vault in one privateOnboard() call");
const t0 = Date.now();
const pe = await privateEntry(10n, 3, undefined, true); // W3: a single privateOnboard() call, deposit included
const f = pe.f;
console.log(`   ${Math.round((Date.now() - t0) / 1000)} s`);

console.log("2) F's account");
const acct = (await fetch(`https://horizon-testnet.stellar.org/accounts/${f.address}`).then((r) => r.json())) as any;
const xlm = acct.balances.find((b: any) => b.asset_type === "native").balance;
console.log(`   XLM ${xlm}, account sponsor ${acct.sponsor?.slice(0, 8)}…, in the vault ${fmt(await chain.balanceOf(f.address))}`);
must(Number(xlm) === 0 && acct.sponsor === relay.address, "F 0 XLM, sponsor relayer");
must((await chain.balanceOf(f.address)) === 10n * U, "F has 10 in the vault");

console.log("3) does any of F's transactions contain a W address (envelope + result bytes)");
for (const [name, h] of Object.entries(pe.txs)) {
  const hits = await addressesIn(h, pe.ws);
  const hasF = (await addressesIn(h, [f.address])).length > 0;
  console.log(`   ${name.padEnd(12)} W trace: ${hits.length ? hits.join(",") : "none"}   F: ${hasF ? "yes" : "no"}`);
  must(hits.length === 0, `W address in the ${name} transaction`);
}
console.log("   visible on chain: three wallets deposited 10 each, F received 10. Which one is F? Unknown.");

console.log("4) F pays over x402");
const seller = await newAgent("seller", 0n, { join: false });
await track([f.address, seller.address], { [f.address]: "F (private)", [seller.address]: "seller" });
const p = await pay(f, seller.address, U);
console.log(`   F -> seller 1: ${p.status}`);
must(p.status === "accepted", "F's payment should be accepted");

console.log("5) the relayer signs only its own transaction shapes");
const post = (path: string, body: unknown) =>
  fetch(`${LEDGER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;
const rAcct = await chain.server.getAccount(relay.address);
const fAcct = await chain.server.getAccount(f.address);
const build = (source: Account, op: xdr.Operation, fee = "100") =>
  new TransactionBuilder(source, { fee, networkPassphrase: chain.cfg.passphrase }).addOperation(op).setTimeout(60).build().toXDR();
const extData = (amt: bigint) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: A.sym("ext_amount"), val: nativeToScVal(amt, { type: "i256" }) }),
    new xdr.ScMapEntry({ key: A.sym("recipient"), val: A.addr(f.address) }),
  ]);
const transact = (amt: bigint, sender: string) => new Contract(pe.pool).call("transact", xdr.ScVal.scvVoid(), extData(amt), A.addr(sender));
const cases: [string, string, unknown, string][] = [
  ["DEPOSIT into the pool (would pull R's money)", "/relay/spp-sign", { xdr: build(rAcct, transact(10n * U, relay.address)) }, "not_a_withdrawal"],
  ["sender is not R", "/relay/spp-sign", { xdr: build(rAcct, transact(-U, f.address)) }, "sender_not_relayer"],
  ["source is not R", "/relay/spp-sign", { xdr: build(fAcct, transact(-U, relay.address)) }, "source_not_relayer"],
  ["another contract (token transfer)", "/relay/spp-sign", { xdr: build(rAcct, new Contract(dep.token).call("transfer", A.addr(relay.address), A.addr(f.address), A.i128(1n))) }, "not_spp_transact"],
  ["fee above the cap", "/relay/spp-sign", { xdr: build(rAcct, transact(-U, relay.address), "50000000") }, "fee_too_high"],
  ["fee-bump: non-vault call", "/relay/fee-bump", { xdr: build(fAcct, new Contract(dep.token).call("transfer", A.addr(f.address), A.addr(seller.address), A.i128(1n))) }, "not_vault_join_or_deposit"],
  ["fee-bump: deposit on someone else's behalf", "/relay/fee-bump", { xdr: build(fAcct, new Contract(dep.hub).call("deposit", A.addr(seller.address), A.i128(1n))) }, "not_self"],
  ["fee-bump: XLM payment", "/relay/fee-bump", { xdr: build(fAcct, Operation.payment({ destination: relay.address, asset: Asset.native(), amount: "1" })) }, "not_vault_join_or_deposit"],
  ["sponsoring an existing account", "/relay/account", { address: f.address }, "account_exists"],
];
for (const [name, path, body, want] of cases) {
  const r = await post(path, body);
  console.log(`   ${name}: ${r.error ?? "SIGNED"}`);
  must(r.error === want, `${name}: expected ${want}, got ${JSON.stringify(r).slice(0, 120)}`);
}

console.log("\nPRIVATE ENTRY CHECK PASSED");
process.exit(0);
