// ADIM D3 + D4 - Golge defter sunucusu.
//
// Tek surec. Fisleri kabul eder (core.ts), operator olarak imzalar, kabul
// sirasinin oneklerini parti olarak zincire gonderir, zincir olaylarini izler.
//
//   POST /vouchers          fis as. {payer, recipient, cumulative, sig}
//   GET  /state             herkesin kilitli / harcanabilir bakiyesi
//   GET  /pair/:p/:r        son kabul edilen kumulatif (odeyen SDK'si toparlanir)
//   GET  /feed              SSE: accepted, refused, batch_sent, batch_settled, ...
//   POST /withdraw          cekim onayi. {who, amount}
//   POST /settle            simdi parti gonder (demo)
//
// Plan: Son 2 Plan/PLAN-golge-defter.md par.3 ve ADIM D3-D4.

import http from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { LedgerCore, pairKey, type Entry } from "./core.ts";
import * as P from "./payload.ts";
import { Chain, TESTNET, voucherScVal, A } from "./chain.ts";

// ================= ayarlar =================

const ROOT = new URL("../../", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployments.json", ROOT), "utf8"));
const env = Object.fromEntries(
  readFileSync(new URL(".env", ROOT), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const PORT = Number(process.env.PORT ?? 8787);
/** Otomatik parti araligi (AUTO_SETTLE acikken). */
const ROUND_MS = Number(process.env.ROUND_MS ?? 30_000);
/** Parti basina en fazla cift. Olculen sinir ~190 (LIMITS.md), %75 pay. */
const MAX_PAIRS = Number(process.env.MAX_PAIRS ?? 150);
const LOG = new URL(process.env.LEDGER_LOG ?? "ledger.log", new URL("../", import.meta.url));
const AUTO_SETTLE = process.env.AUTO_SETTLE !== "0";

const opKp = P.keyFromSeed(env.OPERATOR_SEED);
if (P.pubHex(opKp) !== dep.operator) throw new Error(".env'deki operator anahtari deployments.json ile uyusmuyor");

const hubCfg: P.HubCfg = { networkId: P.networkId(TESTNET.passphrase), hub: dep.hub };
const chain = new Chain({ ...TESTNET, hub: dep.hub, token: dep.token }, opKp.publicKey());
const core = new LedgerCore();

// ================= yardimcilar =================

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x));

const log = (rec: Record<string, unknown>) => appendFileSync(LOG, json({ at: Date.now(), ...rec }) + "\n");

const clients = new Set<http.ServerResponse>();
function emit(event: string, data: Record<string, unknown>) {
  const msg = `event: ${event}\ndata: ${json({ ...data, at: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}

/** Zincirle konusan her sey (parti, tazeleme) sirayla. Kabul bunun disinda. */
let chainLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chainLock.then(fn, fn);
  chainLock = p.catch(() => undefined);
  return p;
}

let latestLedger = 0;
const known = new Set<string>();
/** Arayuz icin adres etiketleri (demo scripti verir). */
const labels = new Map<string, string>();
/** Bilinen adresler log'a yazilir; yeniden acilista /state bos kalmasin. */
function remember(x: string) {
  if (known.has(x)) return;
  known.add(x);
  if (logReady) log({ t: "known", a: x });
}
let logReady = false;
const stats = { accepted: 0, refused: 0, batches: 0, lastBatchTx: "", hubToken: 0n };

// ================= zincir durumu =================

/** En fazla 8 es zamanli RPC. Daha fazlasinda testnet RPC baglantiyi dusuruyor. */
async function pooled<T, R>(items: T[], fn: (x: T) => Promise<R>, width = 8): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(fn))));
  }
  return out;
}

/** Adresleri zincirden tazeler. Ucusta parti varken cagrilmaz (kilit altinda). */
async function refresh(addrs: Iterable<string>, pairs: Iterable<[string, string]> = []) {
  const balances = new Map<string, bigint>();
  const paid = new Map<string, bigint>();
  // Okumalar paralel, uygulama sirali ve senkron.
  const list = [...new Set(addrs)];
  const reads = await pooled(list, (x) =>
    Promise.all([chain.balanceOf(x), chain.signerOf(x), chain.exitAtOf(x)]),
  );
  const pairList = [...pairs];
  const paids = await pooled(pairList, ([p, r]) => chain.paidBetween(p, r));
  list.forEach((x, i) => {
    const [bal, signer, exitAt] = reads[i];
    remember(x);
    balances.set(x, bal);
    if (signer) core.setSigner(x, signer);
    if (exitAt !== null && !core.exiting.has(x)) {
      core.markExiting(x);
      emit("exit_seen", { who: x });
    }
  });
  pairList.forEach(([p, r], i) => paid.set(pairKey(p, r), paids[i]));
  core.reconcile(balances, paid);
}

let cursor: string | undefined;

/** Olaylari okur, ilgili adresleri tazeler. */
async function watch() {
  const start = cursor ? { cursor } : { startLedger: Math.max(1, (await chain.latestLedger()) - 20_000) };
  const res = await chain.events(start);
  cursor = res.cursor;
  latestLedger = res.latest;
  core.expireReservations(latestLedger);

  const dirty = new Set<string>();
  const dirtyPairs: [string, string][] = [];
  let exitSeen = false;
  for (const ev of res.events) {
    const who = ev.topics[0] as string | undefined;
    switch (ev.name) {
      case "joined":
      case "deposited":
        dirty.add(who!);
        break;
      case "exit_started":
        dirty.add(who!);
        exitSeen = true;
        break;
      case "withdrawn":
        if (ev.data.path === "approved") core.withdrawn(who!, BigInt(ev.data.amount as bigint));
        dirty.add(who!);
        break;
      case "settled": {
        const [p, r] = ev.topics as string[];
        dirty.add(p);
        dirty.add(r);
        dirtyPairs.push([p, r]);
        break;
      }
    }
  }
  if (dirty.size) await refresh(dirty, dirtyPairs);
  if (res.events.length) log({ t: "cursor", cursor });
  // Cikis ilani: bekletme, hemen uzlas (plan par.3.5)
  return exitSeen;
}

// ================= parti =================

/** Kabul sirasinin bir onekini zincire gonderir. Kilit ALTINDA cagir. */
async function flushOnce(): Promise<boolean> {
  const b = core.cutBatch(MAX_PAIRS);
  if (!b) return false;
  core.markInflight(b);
  const before = await chain.tokenBalance(dep.hub);
  emit("batch_sent", { uptoSeq: b.uptoSeq, pairs: b.items.length, items: b.items });
  try {
    const res = await chain.invoke(opKp, "settle_batch", [
      A.addr(opKp.publicKey()),
      xdr.ScVal.scvVec(b.items.map(voucherScVal)),
    ]);
    core.batchSettled();
    batchDone();
    stats.batches += 1;
    stats.lastBatchTx = res.hash;
    const out = scValToNative(res.ret!) as {
      total: bigint; settled: number; stale: number; skipped: string[];
    };
    if (out.skipped.length) {
      // Onek parti kurdugumuz surece OLMAMALI. Olursa defterde hata var.
      console.error("UYARI: kontrat odeyen eledi", out.skipped);
    }
    // Zincirin gercegini al (disaridan uzlasmalar dahil)
    const addrs = new Set<string>();
    for (const it of b.items) addrs.add(it.payer).add(it.recipient);
    await refresh(addrs, b.items.map((it) => [it.payer, it.recipient] as [string, string]));
    const after = await chain.tokenBalance(dep.hub);
    stats.hubToken = after;
    log({ t: "settled", uptoSeq: b.uptoSeq, hash: res.hash });
    emit("batch_settled", {
      uptoSeq: b.uptoSeq,
      hash: res.hash,
      ledger: res.ledger,
      total: out.total,
      settled: out.settled,
      stale: out.stale,
      skipped: out.skipped,
      hubTokenBefore: before,
      hubTokenAfter: after,
    });
    return true;
  } catch (err) {
    core.batchFailed();
    batchDone();
    emit("batch_failed", { error: String(err) });
    console.error("parti basarisiz:", err);
    return false;
  }
}

/** Belirli bir seq'e kadar her seyi uzlastir. */
function flushUpTo(seq: number) {
  return locked(async () => {
    while (core.entries.some((e) => e.seq <= seq)) {
      if (!(await flushOnce())) break;
    }
  });
}

// ================= kabul =================

function acceptVoucher(body: {
  payer: string;
  recipient: string;
  cumulative: string;
  sig: string;
  /** alici ara katmani: bu istegin bedeli. Fark bundan azsa ret. */
  min_delta?: string;
}) {
  const v = {
    payer: body.payer,
    recipient: body.recipient,
    cumulative: BigInt(body.cumulative),
    sig: body.sig,
  };
  remember(v.payer);
  remember(v.recipient);
  if (body.min_delta && v.cumulative - core.accepted(v.payer, v.recipient) < BigInt(body.min_delta)) {
    stats.refused += 1;
    emit("refused", { payer: v.payer, recipient: v.recipient, cumulative: v.cumulative, reason: "underpaid" });
    return { status: "refused", reason: "underpaid" };
  }
  const r = core.accept(v, {
    verifySig: (x, signer) => P.verifyHex(signer, P.voucherHash(hubCfg, x.payer, x.recipient, x.cumulative), x.sig),
  });
  if (!r.ok) {
    stats.refused += 1;
    emit("refused", { payer: v.payer, recipient: v.recipient, cumulative: v.cumulative, reason: r.reason });
    return { status: "refused", reason: r.reason };
  }
  // Kabul imzasi: kontrat bunu gormeden fisi kabul etmez.
  r.entry.opSig = P.signHex(opKp, P.acceptHash(hubCfg, v.payer, v.recipient, v.cumulative));
  stats.accepted += 1;
  log({ t: "accept", ...r.entry });
  emit("accepted", {
    seq: r.entry.seq,
    payer: v.payer,
    recipient: v.recipient,
    cumulative: v.cumulative,
    delta: r.entry.delta,
    spendableAfter: r.spendableAfter,
  });
  if (AUTO_SETTLE && core.entries.length >= MAX_PAIRS * 5) void flushUpTo(core.seq);
  return { status: "accepted", seq: r.entry.seq, op_sig: r.entry.opSig, spendable_after: r.spendableAfter };
}

function stateView() {
  const participants = [...known].map((x) => {
    const p = core.pending(x);
    return {
      address: x,
      label: labels.get(x) ?? null,
      joined: core.signers.has(x),
      locked: core.balance(x),
      spendable: core.spendable(x),
      pendingOut: p.out,
      pendingIn: p.in,
      reserved: core.reserved(x),
      exiting: core.exiting.has(x),
    };
  });
  return {
    hub: dep.hub,
    token: dep.token,
    ledger: latestLedger,
    seq: core.seq,
    unsettled: core.entries.length,
    inflight: core.inflight ? core.inflight.uptoSeq : null,
    stats,
    participants,
  };
}

/** Bir sonraki parti denemesi bitince cozulur (basarili ya da degil). */
let batchWaiters: (() => void)[] = [];
function nextBatch(timeoutMs: number): Promise<void> {
  return new Promise((ok) => {
    const t = setTimeout(ok, timeoutMs);
    batchWaiters.push(() => {
      clearTimeout(t);
      ok();
    });
  });
}
function batchDone() {
  const w = batchWaiters;
  batchWaiters = [];
  for (const f of w) f();
}

/**
 * Cekim onayi (plan par.3.6, v3.3.1).
 *
 *   - Ajanin zincirdeki kendi parasindan karsilaniyorsa: ANINDA, parti yok.
 *     Verdigi fisler kasada kalan paradan sonra odenir.
 *   - Bir kismi henuz gelmemis paradan (uzlasmamis gelen fisler) olusuyorsa:
 *     o para zincirde hala odeyenin bakiyesinde. Olagan partiyi bekle, sonra
 *     imzala. Cekim yuzunden EK ISLEM YOK.
 *   - AUTO_SETTLE kapaliysa (demo) olagan parti yok: partiyi hemen gonder.
 */
async function approveWithdraw(body: { who: string; amount: string }) {
  const who = body.who;
  const amount = BigInt(body.amount);
  const validUntil = latestLedger + 60;
  const err = core.reserve(who, amount, validUntil);
  if (err) return { status: "refused", reason: err };
  log({ t: "reserve", who, amount, validUntil });
  emit("withdraw_reserved", { who, amount });

  let path = "direct";
  if (!core.canApprove(who)) {
    path = "after_batch";
    if (AUTO_SETTLE) {
      const deadline = Date.now() + ROUND_MS * 2 + 30_000;
      while (!core.canApprove(who) && Date.now() < deadline) {
        await nextBatch(deadline - Date.now());
      }
    } else {
      await flushUpTo(core.seq);
    }
    if (!core.canApprove(who)) {
      core.release(who, amount);
      log({ t: "release", who, amount, validUntil });
      return { status: "refused", reason: "not_settled_yet" };
    }
  }

  const nonce = await chain.withdrawNonceOf(who);
  const sig = P.signHex(opKp, P.withdrawHash(hubCfg, who, amount, nonce, validUntil));
  emit("withdraw_approved", { who, amount, nonce, validUntil, path });
  return { status: "approved", amount, nonce, valid_until: validUntil, op_sig: sig, path };
}

// ================= HTTP =================

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        fail(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(json(body));
  };
  try {
    if (req.method === "POST" && url.pathname === "/vouchers") {
      const out = acceptVoucher(await readBody(req));
      return send(out.status === "accepted" ? 200 : 402, out);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(readFileSync(new URL("../ui/index.html", import.meta.url)));
    }
    if (req.method === "GET" && url.pathname === "/state") return send(200, stateView());
    if (req.method === "GET" && url.pathname.startsWith("/pair/")) {
      const [, , p, r] = url.pathname.split("/");
      const last = core.entries.filter((e) => e.payer === p && e.recipient === r).at(-1);
      return send(200, {
        accepted: core.accepted(p, r),
        settled: core.paid(p, r),
        sig: last?.sig ?? null,
        op_sig: last?.opSig ?? null,
      });
    }
    if (req.method === "GET" && url.pathname === "/feed") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${json(stateView())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/withdraw") {
      const out = await approveWithdraw(await readBody(req));
      return send(out.status === "approved" ? 200 : 400, out);
    }
    if (req.method === "POST" && url.pathname === "/settle") {
      await flushUpTo(core.seq);
      return send(200, stateView());
    }
    if (req.method === "POST" && url.pathname === "/track") {
      // Demo kolayligi: bir adresi hemen zincirden tazele (olay beklemeden).
      const b = await readBody(req);
      for (const [a, name] of Object.entries(b.labels ?? {})) {
        labels.set(a, String(name));
        log({ t: "label", a, name });
      }
      await locked(() => refresh(b.addresses ?? []));
      return send(200, stateView());
    }
    send(404, { error: "yok" });
  } catch (e) {
    send(400, { error: String(e) });
  }
});

// ================= acilis =================

const loggedKnown = new Set<string>();

async function boot() {
  latestLedger = await chain.latestLedger();
  stats.hubToken = await chain.tokenBalance(dep.hub);
  // Log'u oynat: once zincir durumu, sonra uzlasmamis kabuller.
  if (existsSync(LOG)) {
    const recs = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const addrs = new Set<string>();
    const pairs = new Map<string, [string, string]>();
    for (const r of recs) {
      if (r.t === "accept") {
        addrs.add(r.payer).add(r.recipient);
        pairs.set(pairKey(r.payer, r.recipient), [r.payer, r.recipient]);
      }
      if (r.t === "cursor") cursor = r.cursor;
      if (r.t === "label") labels.set(r.a, r.name);
      if (r.t === "known") {
        addrs.add(r.a);
        loggedKnown.add(r.a);
      }
    }
    await refresh(addrs, pairs.values());
    for (const r of recs) {
      if (r.t === "accept") {
        core.restore({ ...r, cumulative: BigInt(r.cumulative), delta: BigInt(r.delta) } as Entry);
      }
      if (r.t === "reserve" && r.validUntil >= latestLedger) {
        core.reserve(r.who, BigInt(r.amount), r.validUntil);
      }
      if (r.t === "release") core.release(r.who, BigInt(r.amount));
    }
    for (const a of addrs) known.add(a);
    console.log(`log oynatildi: seq ${core.seq}, uzlasmamis ${core.entries.length}`);
  }
  logReady = true;
  for (const a of known) if (!loggedKnown.has(a)) log({ t: "known", a });
  await locked(watch);

  server.listen(PORT, () => {
    console.log(`golge defter: http://localhost:${PORT}  hub ${dep.hub}`);
    console.log(`operator: ${opKp.publicKey()}  tur ${ROUND_MS} ms, parti <= ${MAX_PAIRS} cift`);
  });

  // izleyici: her 4 sn
  setInterval(() => {
    void locked(watch)
      .then((exitSeen) => (exitSeen ? flushUpTo(core.seq) : undefined))
      .catch((e) => console.error("izleyici:", e.message));
  }, 4000);
  // partici: her tur
  if (AUTO_SETTLE) setInterval(() => void flushUpTo(core.seq), ROUND_MS);
}

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});

