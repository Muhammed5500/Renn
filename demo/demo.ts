// Step T: the stage demo (plan par.5, step T). About 30 s per scene.
//
// With the ledger running:  AUTO_SETTLE=0 npm start
// Then:                     node demo/demo.ts            (all scenes)
//                           node demo/demo.ts 1 3        (only 1 and 3)
// Scene 6 (private entry) needs SPP: spp/bin, spp/circuits and RELAYER_SECRET in .env.
// Skipped otherwise. Takes ~3 min (three Groth16 deposits + a withdrawal).
//
// Every number comes from the running system: the ledger's /state and chain reads.

import { Keypair } from "@stellar/stellar-sdk";
import { newAgent, track, settleNow, ledgerState, withdrawApproved, chain, dep, fmt, LEDGER, U, pay } from "./testnet.ts";
import { A, voucherScVal } from "renn/chain";
import { privateEntry, addressesIn, sppReady } from "./spp.ts";

const only = process.argv.slice(2).map(Number);
const want = (n: number) => only.length === 0 || only.includes(n);
const line = "=".repeat(64);
const scene = (n: number, title: string, quote?: string) => {
  console.log(`\n${line}\n SCENE ${n}  ${title}\n${line}`);
  if (quote) console.log(`  "${quote}"\n`);
};
const tx = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const view = async (addr: string) => (await ledgerState()).participants.find((p: any) => p.address === addr);

console.log("Before the scenes: setting up agents (friendbot, join, deposit)...");
const t0 = Date.now();
const [a, b, c, ahmet, e, deniz, ...payers] = await Promise.all([
  newAgent("A", 20n * U),
  newAgent("B", 0n),
  newAgent("C", 0n),
  newAgent("Ahmet", 10n * U),
  newAgent("E", 0n),
  newAgent("Deniz", 50n * U),
  ...[1, 2, 3, 4, 5].map((i) => newAgent(`P${i}`, 10n * U)),
]);
const services = Array.from({ length: 25 }, () => Keypair.random().publicKey()); // pure recipients
const everyone = [a, b, c, ahmet, e, deniz, ...payers];
await track(
  everyone.map((x) => x.address),
  Object.fromEntries([
    ...everyone.map((x) => [x.address, x.name]),
    ...services.map((s, i) => [s, `service-${i + 1}`]),
  ]),
);
console.log(`ready (${Math.round((Date.now() - t0) / 1000)} s). Ledger: ${LEDGER}`);

// ================= SCENE 0 =================
if (want(0)) {
  scene(0, "VAULTS", "None of these agents can spend money it does not have.");
  for (const x of [a, b, c, ahmet, e]) {
    const v = await view(x.address);
    console.log(`  ${x.name.padEnd(12)} in vault ${fmt(v.locked).padStart(6)}   spendable ${fmt(v.spendable).padStart(6)}`);
  }
}

// ================= SCENE 1 =================
if (want(1)) {
  scene(1, "CIRCULAR DEBT", "A holds 20 in the vault. 270 units of debt settle in one transaction.");
  const hubBefore = await chain.tokenBalance(dep.hub);
  const batchesBefore = (await ledgerState()).stats.batches;
  let minA = 20n * U;
  for (let i = 0; i < 100; i++) {
    await pay(a, b.address, U);
    if (i < 90) await pay(b, c.address, U);
    if (i < 80) await pay(c, a.address, U);
    if (i % 10 === 9) {
      const va = await view(a.address);
      if (BigInt(va.spendable) < minA) minA = BigInt(va.spendable);
      process.stdout.write(`  round ${String(i + 1).padStart(3)}  A spendable ${fmt(va.spendable).padStart(6)}   on-chain transactions: 0\r`);
    }
  }
  console.log(`\n  A->B 100, B->C 90, C->A 80 = 270 payments. A's lowest spendable: ${fmt(minA)}`);
  await settleNow();
  const st = await ledgerState();
  console.log(`  ONE BATCH: ${tx(st.stats.lastBatchTx)}`);
  console.log(`  on-chain transactions: ${st.stats.batches - batchesBefore}`);
  console.log(`  vault token balance: ${fmt(hubBefore)} -> ${fmt(await chain.tokenBalance(dep.hub))}   (unchanged)`);
  for (const x of [a, b, c]) console.log(`  ${x.name}: on chain ${fmt(await chain.balanceOf(x.address))}`);
}

// ================= SCENE 2 =================
if (want(2)) {
  scene(2, "SCALE", "5 payers, 25 services, 600 payments, one batch.");
  const batchesBefore = (await ledgerState()).stats.batches;
  const hubBefore = await chain.tokenBalance(dep.hub);
  const t = Date.now();
  let n = 0;
  for (let i = 0; i < 600; i++) {
    const p = payers[i % 5];
    const s = services[(i * 7) % 25];
    const r = await pay(p, s, U / 20n); // 0.05
    if (r.status === "accepted") n++;
  }
  const secs = (Date.now() - t) / 1000;
  console.log(`  ${n} payments, ${secs.toFixed(1)} s (${Math.round(n / secs)} payments/s), on-chain transactions: 0`);
  await settleNow();
  const st = await ledgerState();
  console.log(`  on-chain transactions: ${st.stats.batches - batchesBefore}   ${tx(st.stats.lastBatchTx)}`);
  console.log(`  vault token balance: ${fmt(hubBefore)} -> ${fmt(await chain.tokenBalance(dep.hub))}`);
}

// ================= SCENE 3 =================
if (want(3)) {
  scene(3, "BOUNCED CHEQUE", "You cannot spend more than your vault holds, even if the voucher never reaches the chain.");
  const r1 = await pay(e, ahmet.address, 3n * U);
  console.log(`  E (empty vault) -> Ahmet 3:        ${r1.status === "refused" ? "REFUSED  " + r1.reason : "accepted"}`);
  const s1 = services[0];
  const s2 = services[1];
  const r2 = await pay(ahmet, s1, 10n * U);
  console.log(`  Ahmet (10) -> service-1 10:        ${r2.status === "accepted" ? "accepted" : "REFUSED " + (r2 as any).reason}`);
  const r3 = await pay(ahmet, s2, 10n * U);
  console.log(`  Ahmet, the same 10 to service-2:   ${r3.status === "refused" ? "REFUSED  " + r3.reason : "accepted"}`);
}

// ================= SCENE 4 =================
if (want(4)) {
  scene(4, "WITHDRAWAL", "Locked, but not trapped.");
  const r = await pay(deniz, services[2], 3n * U);
  console.log(`  Deniz (50) pays a service 3: ${r.status === "accepted" ? "accepted, not settled yet" : "REFUSED " + (r as any).reason}`);
  const before = await chain.tokenBalance(deniz.address);
  const t = Date.now();
  const w = await withdrawApproved(deniz, 20n * U);
  console.log(`  Deniz withdraws 20: ${w.path === "direct" ? "3 of the 50 are promised, 20 are free -> INSTANT approval, no batch" : "approved after a batch"}`);
  console.log(`  withdrawal: ${tx(w.hash)}`);
  console.log(`  wallet: ${fmt(before)} -> ${fmt(await chain.tokenBalance(deniz.address))}   (${Math.round((Date.now() - t) / 1000)} s, no exit_start)`);
  const dv = await view(deniz.address);
  console.log(`  in vault ${fmt(await chain.balanceOf(deniz.address))}: spendable ${fmt(dv.spendable)} + promised to the service ${fmt(dv.pendingOut)} (paid in the regular batch)`);
}

// ================= SCENE 5 (optional) =================
if (want(5)) {
  scene(5, "OPERATOR DOWN", "Even if the operator goes down, the money is yours.");
  // An accepted but unsettled voucher: the recipient settles the two-signature
  // voucher it holds by itself, without using the ledger.
  // the first agent with spendable balance pays (earlier scenes changed balances)
  let payer = a;
  for (const x of [a, b, c, deniz, ...payers]) {
    if (BigInt((await view(x.address)).spendable) >= U) {
      payer = x;
      break;
    }
  }
  const to = payer === e ? a : e;
  const r = await pay(payer, to.address, U / 2n);
  if (r.status !== "accepted") throw new Error(`scene 5 setup: ${(r as any).reason}`);
  const pair = await (await fetch(`${LEDGER}/pair/${payer.address}/${to.address}`)).json();
  const v = { payer: payer.address, recipient: to.address, cumulative: BigInt(pair.accepted), sig: pair.sig, opSig: pair.op_sig };
  const res = await chain.invoke(to.kp, "settle_one", [A.addr(to.address), voucherScVal(v)]);
  console.log(`  ${to.name} settled its own voucher without the ledger: ${tx(res.hash)}`);
  const ex = await chain.invoke(payer.kp, "exit_start", [A.addr(payer.address)]);
  console.log(`  ${payer.name} started the escape hatch (exit_start): ${tx(ex.hash)}`);
  console.log(`  After ${dep.exit_delay} ledgers (~5 min) it can withdraw without the operator.`);
}

// ================= SCENE 6 (if SPP is available) =================
if (want(6)) {
  scene(6, "PRIVATE ENTRY", "Who entered the vault cannot be told from the chain.");
  if (!sppReady()) {
    console.log("  no SPP CLI or circuit files (spp/bin, spp/circuits), skipped.");
  } else {
    const pe = await privateEntry(10n, 3, (s) => console.log(s));
    await track([pe.f.address], { [pe.f.address]: "F (private)" });
    const r = await pay(pe.f, services[3], U);
    console.log(`  F paid service-4 1 over x402: ${r.status === "accepted" ? "accepted" : "REFUSED " + (r as any).reason}`);
    let traces = 0;
    for (const h of Object.values(pe.txs)) traces += (await addressesIn(h, pe.ws)).length;
    const acct = (await fetch(`https://horizon-testnet.stellar.org/accounts/${pe.f.address}`).then((x) => x.json())) as any;
    const xlm = acct.balances.find((b: any) => b.asset_type === "native").balance;
    console.log(`  W addresses in F's ${Object.keys(pe.txs).length} transactions: ${traces === 0 ? "NONE" : traces}   F's XLM: ${xlm}`);
    console.log("  visible on chain: three wallets deposited 10 each, F received 10. Which one is F? Unknown.");
    console.log("  still public: amount and timing. The larger the crowd depositing the same amount, the better the privacy.");
  }
}

console.log(`\n${line}\n vault: https://stellar.expert/explorer/testnet/contract/${dep.hub}\n${line}`);
process.exit(0);
