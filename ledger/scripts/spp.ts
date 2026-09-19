// Resmi SPP CLI'yi (Nethermind stellar-private-payments) cagiran ince sarmalayici.
//
// Varsayilan yerler (git'e girmez, kurulum README "Private entry"):
//   spp/bin/spp[.exe]   SPP CLI (kaynaktan derlendi, 10ffa0e)
//   spp/circuits/       circuits-v0.4, circuits.json'daki sha256'larla dogrulandi
// Ortamla degistirilebilir: SPP_BIN, SPP_CIRCUITS.
//
// Hesaplar `stellar keys` takma adlari. Relayer'in takma adi `gd-relay`:
// STELLAR_BIN spp-shim/'e yonlenir, o da imzayi deftere (relayer) sorar.

import { execFile, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { LEDGER, chain, mint, asTestAgent, hubCfg, fmt, U } from "./testnet.ts";
import { A } from "../src/chain.ts";
import { Agent } from "../src/agent.ts";
import { openSponsored, relayedInvoke } from "../src/private.ts";

const ROOT = new URL("../../", import.meta.url);
export const sppDep = fileURLToPath(new URL("spp/deployments.json", ROOT));
const shim = fileURLToPath(new URL(process.platform === "win32" ? "../spp-shim/stellar.cmd" : "../spp-shim/stellar", import.meta.url));
const localBin = fileURLToPath(new URL(`spp/bin/spp${process.platform === "win32" ? ".exe" : ""}`, ROOT));
const localCircuits = fileURLToPath(new URL("spp/circuits", ROOT));
const BIN = process.env.SPP_BIN ?? (existsSync(localBin) ? localBin : "spp");
const CIRCUITS = process.env.SPP_CIRCUITS ?? (existsSync(join(localCircuits, "policy_tx_2_2_B.r1cs")) ? localCircuits : undefined);

/** SPP adimlari calisabilir mi (ikili + devre dosyalari). */
export const sppReady = () => !!CIRCUITS && (BIN === "spp" || existsSync(BIN));

export const RELAY_ALIAS = "gd-relay";

/** Her hesabin kendi SPP cuzdan klasoru (not veritabani, anahtarlar). */
const dataDirs = new Map<string, string>();
function dataDir(account: string) {
  if (!dataDirs.has(account)) dataDirs.set(account, mkdtempSync(join(tmpdir(), `spp-${account}-`)));
  return dataDirs.get(account)!;
}

/** Gecici SPP cuzdan klasorlerini sil (notlar ve anahtarlar). */
export function cleanup() {
  for (const d of dataDirs.values()) rmSync(d, { recursive: true, force: true });
  dataDirs.clear();
}

export function spp(account: string, args: string[], signAs?: string): Promise<string> {
  if (!CIRCUITS) throw new Error("SPP devre dosyalari yok: spp/circuits/ ya da SPP_CIRCUITS");
  const full = [
    "--deployment", sppDep,
    "--circuits-dir", CIRCUITS,
    "--data-dir", dataDir(account),
    "--account", account,
    ...(signAs ? ["--sign-as", signAs] : []),
    ...args,
  ];
  return new Promise((ok, fail) => {
    const child = execFile(
      BIN,
      full,
      { env: { ...process.env, STELLAR_BIN: shim, GD_RELAY_URL: LEDGER }, maxBuffer: 16 << 20, timeout: 300_000 },
      (err, stdout, stderr) => (err ? fail(new Error(`spp ${args[0]}: ${stderr || err.message}`)) : ok(stdout + stderr)),
    );
    // onboard'un istegleri (bootnode, explorer) bos girdiyle varsayilani alir
    child.stdin?.end();
  });
}

const txHash = (out: string) => {
  const m = out.match(/tx_hash\W+([0-9a-f]{64})/);
  if (!m) throw new Error(`spp ciktisinda tx_hash yok:\n${out.slice(-400)}`);
  return m[1];
};

export async function onboard(account: string) {
  await spp(account, ["onboard", "--accept", "--no-register", "--no-bootnode"]);
}

/** Genel token'i havuza yatir (W kendisi oder: W zaten bilinen hesap). */
export async function deposit(account: string, pool: string, amount: string) {
  return txHash(await spp(account, ["deposit", pool, amount]));
}

/** Havuzdan `to`'ya cek. Kaynak ve ucret relayer: islemde W yok. */
export async function withdraw(account: string, pool: string, amount: string, to: string) {
  return txHash(await spp(account, ["withdraw", pool, amount, "--to", to], RELAY_ALIAS));
}

// ================= gizli giris akisi =================

/**
 * n bilinen cuzdan (W) havuza `amount` yatirir; biri taze F'ye ceker; F
 * relayer ile 0 XLM hesap acar, kasaya katilir ve yatirir. F x402 ile odemeye
 * hazir ajan olarak doner. Test cuzdanlari sonunda silinir.
 */
export async function privateEntry(amount = 10n, n = 3, say = (s: string) => console.log(s)) {
  const pool = JSON.parse(readFileSync(sppDep, "utf8")).pools[0].poolContractId as string;
  const units = fmt(amount * U).replace(/\.00$/, "");
  const tag = Date.now().toString(36);
  const ws = Array.from({ length: n }, (_, i) => `gd_w${i + 1}_${tag}`);
  const wAddr: Record<string, string> = {};
  try {
    say(`  ${n} bilinen cuzdan hazirlaniyor (friendbot, ${units} RTUSD, SPP anahtarlari)`);
    for (const w of ws) {
      execSync(`stellar keys generate ${w} --network testnet --fund`, { stdio: "ignore" });
      wAddr[w] = execSync(`stellar keys address ${w}`).toString().trim();
    }
    for (const w of ws) await mint(wAddr[w], amount * U);
    await Promise.all(ws.map((w) => onboard(w)));

    // Sirayla: ayni havuza ayni ledger'da iki yatirma, ikisi de ayni agac
    // durumuna gore hazirlandigi icin biri reddedilir.
    const deps: string[] = [];
    for (const [i, w] of ws.entries()) {
      deps.push(await deposit(w, pool, units));
      say(`  W${i + 1} ${wAddr[w].slice(0, 8)}… havuza ${units} yatirdi   https://stellar.expert/explorer/testnet/tx/${deps.at(-1)}`);
    }

    const chosen = ws[randomInt(n)];
    const f = Keypair.random();
    const wd = await withdraw(chosen, pool, units, f.publicKey());
    say(`  havuzdan taze F'ye ${units}: ${f.publicKey().slice(0, 8)}…   https://stellar.expert/explorer/testnet/tx/${wd}`);
    if ((await chain.tokenBalance(f.publicKey())) !== amount * U) throw new Error("F havuzdan parayi almadi");

    const agent = new Agent({ address: f.publicKey(), seedHex: randomBytes(32).toString("hex"), ledgerUrl: LEDGER, hub: hubCfg });
    const opened = await openSponsored(LEDGER, f, chain);
    const joined = await relayedInvoke(LEDGER, f, chain, "join", [A.addr(f.publicKey()), A.bytes(agent.commitmentKey)]);
    const deposited = await relayedInvoke(LEDGER, f, chain, "deposit", [A.addr(f.publicKey()), A.i128(amount * U)]);
    say(`  F 0 XLM ile hesap acti, kasaya katildi, ${units} yatirdi (ucretler relayer'dan)`);

    return {
      f: asTestAgent("F", f, agent),
      pool,
      ws: ws.map((w) => wAddr[w]),
      chosen: wAddr[chosen],
      deposits: deps,
      txs: { cekim: wd, "hesap ac": opened.hash, join: joined.hash, deposit: deposited.hash },
    };
  } finally {
    for (const w of ws) execSync(`stellar keys rm --force ${w}`, { stdio: "ignore" });
    cleanup();
  }
}

/** Islem zarfi + sonuc baytlarinda bu adreslerden hangileri geciyor. */
export async function addressesIn(hash: string, addrs: string[]) {
  const t = (await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`).then((r) => r.json())) as any;
  const raw = Buffer.concat([Buffer.from(t.envelope_xdr, "base64"), Buffer.from(t.result_meta_xdr ?? "", "base64")]);
  return addrs.filter((a) => raw.includes(StrKey.decodeEd25519PublicKey(a)));
}
