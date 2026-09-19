// Step L: limit measurement. SIMULATES settle_batch with N pairs (nothing is
// sent), finds the first N that fails and the resource use. Results go to LIMITS.md.
import { readFileSync } from "node:fs";
import { Keypair, TransactionBuilder, Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { newAgent, chain, hubCfg, dep, U } from "./testnet.ts";
import { voucherScVal, A } from "@golge-defter/sdk/chain";
import * as P from "@golge-defter/sdk/payload";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const op = P.keyFromSeed(env.match(/OPERATOR_SEED=(\w+)/)![1]);

const payers = await Promise.all([1, 2, 3, 4, 5].map((i) => newAgent(`P${i}`, 1000n * U)));
const recipients = Array.from({ length: 80 }, () => Keypair.random().publicKey());

function vouchers(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = payers[i % 5];
    const r = recipients[Math.floor(i / 5)];
    const v = p.agent.voucher(r, U);
    out.push({
      payer: v.payer, recipient: v.recipient, cumulative: BigInt(v.cumulative), sig: v.sig,
      opSig: P.signHex(op, P.acceptHash(hubCfg, v.payer, v.recipient, BigInt(v.cumulative))),
    });
  }
  return out;
}

async function sim(n: number) {
  const acct = await chain.server.getAccount(op.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: chain.cfg.passphrase })
    .addOperation(new Contract(dep.hub).call("settle_batch", A.addr(op.publicKey()), xdr.ScVal.scvVec(vouchers(n).map(voucherScVal))))
    .setTimeout(30).build();
  const s = await chain.server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(s)) return { n, ok: false, err: String((s as any).error).slice(0, 160) };
  const res: any = (s.transactionData as any).build();
  const r = res.resources ?? res._attributes?.resources;
  const get = (o: any, k: string) => (typeof o?.[k] === "function" ? o[k]() : o?.[k]);
  return {
    n, ok: true,
    instructions: Number(get(r, "instructions")),
    diskReadBytes: Number(get(r, "diskReadBytes")),
    writeBytes: Number(get(r, "writeBytes")),
    feeXLM: Number(s.minResourceFee) / 1e7,
    txBytes: tx.toXDR().length,
  };
}

for (const n of (process.argv[2] ?? "1,5,10,20,30,40,50,60,80,100").split(",").map(Number)) {
  const r = await sim(n);
  console.log(JSON.stringify(r));
  if (!r.ok) break;
}

// ---- steady state: the same pairs a second time (storage entries already exist) ----
if (process.env.STEADY) {
  const n = Number(process.env.STEADY);
  const first = vouchers(n);
  const res = await chain.invoke(op, "settle_batch", [A.addr(op.publicKey()), xdr.ScVal.scvVec(first.map(voucherScVal))]);
  console.log("first batch (new entries) sent:", res.hash);
  for (const v of first) {
    const p = payers.find((x) => x.address === v.payer)!;
    p.agent.cum.set(v.recipient, v.cumulative);
  }
  console.log("same pairs, second batch:", JSON.stringify(await sim(n)));
}
