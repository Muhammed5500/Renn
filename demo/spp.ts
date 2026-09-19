// Private entry for the demo and checks. The flow itself is the SDK's
// privateOnboard(); this file only prepares test wallets (friendbot, test
// token) and a crowd of depositors.
//
// Default locations (gitignored, setup in README "Private entry"):
//   spp/bin/spp[.exe]   SPP CLI, built from source (10ffa0e)
//   spp/circuits/       circuits-v0.4, checked against circuits.json
// Override with SPP_BIN, SPP_CIRCUITS.

import { execSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { SppCli, privateOnboard, units } from "@golge-defter/sdk";
import { LEDGER, chain, mint, asTestAgent, U } from "./testnet.ts";

const ROOT = new URL("../", import.meta.url);
export const sppDep = fileURLToPath(new URL("spp/deployments.json", ROOT));
const BIN = process.env.SPP_BIN ?? fileURLToPath(new URL(`spp/bin/spp${process.platform === "win32" ? ".exe" : ""}`, ROOT));
const CIRCUITS = process.env.SPP_CIRCUITS ?? fileURLToPath(new URL("spp/circuits", ROOT));

/** SPP binary and circuits present. */
export const sppReady = () => SppCli.ready(BIN, CIRCUITS);

/**
 * n known wallets (W) deposit `amount` into the pool; one of them enters the
 * vault privately as a fresh F. Returns F as an x402-ready test agent.
 *
 * oneCall: false (demo): all n deposit first, a random one withdraws with
 *   privateOnboard({ deposit: false }). F could be any of them.
 * oneCall: true (check): n-1 deposit, the last wallet does the whole flow with
 *   a single privateOnboard() call, deposit included.
 *
 * Test wallets are removed from `stellar keys` at the end.
 */
export async function privateEntry(amount = 10n, n = 3, say = (s: string) => console.log(s), oneCall = false) {
  const cli = new SppCli({ bin: BIN, circuits: CIRCUITS, deployment: sppDep, relayUrl: LEDGER });
  const u = units(amount * U);
  const tag = Date.now().toString(36);
  const ws = Array.from({ length: n }, (_, i) => `gd_w${i + 1}_${tag}`);
  const wAddr: Record<string, string> = {};
  try {
    say(`  preparing ${n} known wallets (friendbot, ${u} RTUSD, SPP keys)`);
    for (const w of ws) {
      execSync(`stellar keys generate ${w} --network testnet --fund`, { stdio: "ignore" });
      wAddr[w] = execSync(`stellar keys address ${w}`).toString().trim();
    }
    for (const w of ws) await mint(wAddr[w], amount * U);
    await Promise.all(ws.map((w) => cli.onboard(w)));

    // One at a time: two deposits into the same pool in the same ledger are
    // built against the same tree state and one of them is rejected.
    const crowd = oneCall ? ws.slice(0, -1) : ws;
    const deposits: string[] = [];
    for (const [i, w] of crowd.entries()) {
      deposits.push(await cli.deposit(w, amount * U));
      say(`  W${i + 1} ${wAddr[w].slice(0, 8)}… deposited ${u} into the pool   https://stellar.expert/explorer/testnet/tx/${deposits.at(-1)}`);
    }

    const chosen = oneCall ? ws[n - 1] : ws[randomInt(n)];
    const r = await privateOnboard({
      spp: cli,
      wallet: chosen,
      amount: amount * U,
      chain,
      ledgerUrl: LEDGER,
      deposit: oneCall,
    });
    if (r.txs.sppDeposit) {
      deposits.push(r.txs.sppDeposit);
      say(`  W${n} ${wAddr[chosen].slice(0, 8)}… deposited ${u} into the pool   https://stellar.expert/explorer/testnet/tx/${r.txs.sppDeposit}`);
    }
    say(`  ${u} from the pool to a fresh F ${r.address.slice(0, 8)}…   https://stellar.expert/explorer/testnet/tx/${r.txs.sppWithdraw}`);
    say(`  F opened an account with 0 XLM, joined the vault, deposited ${u} (fees paid by the relayer)`);

    return {
      f: asTestAgent("F", r.keypair, r.agent),
      pool: cli.pool,
      ws: ws.map((w) => wAddr[w]),
      chosen: wAddr[chosen],
      deposits,
      txs: { withdrawal: r.txs.sppWithdraw, "open account": r.txs.openAccount, join: r.txs.join, deposit: r.txs.deposit },
    };
  } finally {
    for (const w of ws) execSync(`stellar keys rm --force ${w}`, { stdio: "ignore" });
    cli.cleanup();
  }
}

/** Which of these addresses appear in a transaction's envelope and result bytes. */
export async function addressesIn(hash: string, addrs: string[]) {
  const t = (await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`).then((r) => r.json())) as any;
  const raw = Buffer.concat([Buffer.from(t.envelope_xdr, "base64"), Buffer.from(t.result_meta_xdr ?? "", "base64")]);
  return addrs.filter((a) => raw.includes(StrKey.decodeEd25519PublicKey(a)));
}
