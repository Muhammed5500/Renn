// STEP D3 + D4 - Shadow ledger server.
//
// One process. Accepts vouchers (core.ts), signs them as the operator, sends
// prefixes of the acceptance order to the chain as batches, watches chain events.
//
//   GET  /state             everyone's locked / spendable balance
//   GET  /pair/:p/:r        last accepted cumulative (the payer SDK recovers from it)
//   GET  /feed              SSE: accepted, refused, batch_sent, batch_settled, ...
//   POST /withdraw          withdrawal approval. {who, amount}
//   POST /flush             send a batch now (demo)
//   GET  /supported         x402 facilitator: supported scheme and network
//   POST /verify            x402 facilitator: would the voucher be accepted (read-only)
//   POST /settle            x402 facilitator: accept the voucher into the ledger
//
// Plan: PLAN-golge-defter.md (outside the repo, one level above Proje/) par.3 and STEP D3-D4.

import http from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { LedgerCore, pairKey, type Entry } from "./core.ts";
import * as P from "@golge-defter/sdk/payload";
import { Chain, TESTNET, voucherScVal, A } from "@golge-defter/sdk/chain";
import { SCHEME, NETWORK, type VoucherPayload } from "@golge-defter/sdk/x402";
import { Relayer } from "./relay.ts";

// ================= settings =================

const ROOT = new URL("../../", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployments.json", ROOT), "utf8"));
const env = Object.fromEntries(
  readFileSync(new URL(".env", ROOT), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const PORT = Number(process.env.PORT ?? 8787);
// ---- batch triggers (when AUTO_SETTLE is on; whichever comes first) ----
/** Time: a batch at this interval if anything is unsettled. Demo 30 s, default 5 min. */
const ROUND_MS = Number(process.env.ROUND_MS ?? 300_000);
/** Capacity: number of DISTINCT unsettled pairs. Also the per-transaction limit.
 *  Measured limit ~190 pairs (LIMITS.md), 75% of it. */
const MAX_PAIRS = Number(process.env.MAX_PAIRS ?? 150);
/** Value: unsettled total (7-decimal integer). Default 1000 units. */
const MAX_UNSETTLED = BigInt(process.env.MAX_UNSETTLED ?? 1000n * 10_000_000n);
/** Value: what a single recipient is owed. Default 100 units. Limits the
 *  amount that relies on the operator: large payments reach the chain without waiting. */
const MAX_RECIPIENT_UNSETTLED = BigInt(process.env.MAX_RECIPIENT_UNSETTLED ?? 100n * 10_000_000n);
const LOG = new URL(process.env.LEDGER_LOG ?? "ledger.log", new URL("../", import.meta.url));
const AUTO_SETTLE = process.env.AUTO_SETTLE !== "0";
/** Address where x402 clients find the ledger (announced in /supported). */
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

const opKp = P.keyFromSeed(env.OPERATOR_SEED);
if (P.pubHex(opKp) !== dep.operator) throw new Error("the operator key in .env does not match deployments.json");

const hubCfg: P.HubCfg = { networkId: P.networkId(TESTNET.passphrase), hub: dep.hub };
const chain = new Chain({ ...TESTNET, hub: dep.hub, token: dep.token }, opKp.publicKey());
const core = new LedgerCore();

/** Private entry (SPP) relayer. Off when .env has no RELAYER_SECRET. */
const spp = existsSync(new URL("spp/deployments.json", ROOT))
  ? JSON.parse(readFileSync(new URL("spp/deployments.json", ROOT), "utf8"))
  : null;
const relayer =
  env.RELAYER_SECRET && spp
    ? new Relayer(
        env.RELAYER_SECRET,
        {
          passphrase: TESTNET.passphrase,
          hub: dep.hub,
          sppPool: spp.pools[0].poolContractId,
          maxFee: Number(process.env.RELAY_MAX_FEE ?? 10_000_000),
          perHour: Number(process.env.RELAY_PER_HOUR ?? 60),
        },
        chain,
      )
    : null;

// ================= helpers =================

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x));

const log = (rec: Record<string, unknown>) => appendFileSync(LOG, json({ at: Date.now(), ...rec }) + "\n");

const clients = new Set<http.ServerResponse>();
function emit(event: string, data: Record<string, unknown>) {
  const msg = `event: ${event}\ndata: ${json({ ...data, at: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}

/** Everything that talks to the chain (batches, refreshes) runs in order. Acceptance is outside this. */
let chainLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chainLock.then(fn, fn);
  chainLock = p.catch(() => undefined);
  return p;
}

let latestLedger = 0;
const known = new Set<string>();
/** Address labels for the dashboard (set by the demo script). */
const labels = new Map<string, string>();
/** Known addresses are logged so /state is not empty after a restart. */
function remember(x: string) {
  if (known.has(x)) return;
  known.add(x);
  if (logReady) log({ t: "known", a: x });
}
let logReady = false;
const stats = {
  accepted: 0,
  refused: 0,
  batches: 0,
  lastBatchTx: "",
  hubToken: 0n,
  /** what triggered the last batch: time | capacity | total | recipient | exit | withdraw | manual */
  lastBatchReason: "",
  reasons: {} as Record<string, number>,
};

// ================= chain state =================

/** At most 8 concurrent RPC calls. With more, the testnet RPC drops connections. */
async function pooled<T, R>(items: T[], fn: (x: T) => Promise<R>, width = 8): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(fn))));
  }
  return out;
}

/** Refreshes addresses from the chain. Never called while a batch is in flight (runs under the lock). */
async function refresh(addrs: Iterable<string>, pairs: Iterable<[string, string]> = []) {
  const balances = new Map<string, bigint>();
  const paid = new Map<string, bigint>();
  // Reads in parallel; applying them is ordered and synchronous.
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

/** Reads events and refreshes the addresses involved. */
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
    chain.observe(ev.ledger); // read the state after this event
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
  // Exit announced: don't wait, settle now (plan par.3.5)
  return exitSeen;
}

// ================= batches =================

/** Sends a prefix of the acceptance order to the chain. Call UNDER the lock. */
async function flushOnce(reason: string): Promise<boolean> {
  const b = core.cutBatch(MAX_PAIRS);
  if (!b) return false;
  core.markInflight(b);
  const before = await chain.tokenBalance(dep.hub);
  emit("batch_sent", { uptoSeq: b.uptoSeq, pairs: b.items.length, items: b.items, reason });
  try {
    const res = await chain.invoke(opKp, "settle_batch", [
      A.addr(opKp.publicKey()),
      xdr.ScVal.scvVec(b.items.map(voucherScVal)),
    ]);
    core.batchSettled();
    batchDone();
    stats.batches += 1;
    stats.lastBatchReason = reason;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    stats.lastBatchTx = res.hash;
    const out = scValToNative(res.ret!) as {
      total: bigint; settled: number; stale: number; skipped: string[];
    };
    if (out.skipped.length) {
      // Must NOT happen as long as we build prefix batches. If it does, the ledger has a bug.
      console.error("WARNING: the contract dropped a payer", out.skipped);
    }
    // Take the chain's truth (including settlements from outside)
    const addrs = new Set<string>();
    for (const it of b.items) addrs.add(it.payer).add(it.recipient);
    await refresh(addrs, b.items.map((it) => [it.payer, it.recipient] as [string, string]));
    const after = await chain.tokenBalance(dep.hub);
    stats.hubToken = after;
    log({ t: "settled", uptoSeq: b.uptoSeq, hash: res.hash });
    emit("batch_settled", {
      reason,
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
    console.error("batch failed:", err);
    return false;
  }
}

/** Settle everything up to a given seq. */
function flushUpTo(seq: number, reason = "manual") {
  return locked(async () => {
    while (core.entries.some((e) => e.seq <= seq)) {
      if (!(await flushOnce(reason))) break;
    }
  });
}

/**
 * Batch request from a trigger. Back-to-back requests merge into ONE queued
 * batch: while one is waiting, no new one is added.
 */
let flushQueued = false;
function requestFlush(reason: string) {
  if (flushQueued) return;
  flushQueued = true;
  // ONLY what was accepted up to the moment of the request. New vouchers that
  // arrive while a batch is in flight wait for their own trigger; otherwise the
  // loop never stops under heavy traffic and the time trigger's cost control
  // becomes meaningless.
  const upto = core.seq;
  void locked(async () => {
    flushQueued = false;
    while (core.entries.some((e) => e.seq <= upto)) {
      if (!(await flushOnce(reason))) break;
    }
  });
}

/** After every acceptance: capacity and value triggers. */
function checkTriggers() {
  if (!AUTO_SETTLE) return;
  const s = core.unsettledSummary();
  const reason =
    s.pairs >= MAX_PAIRS ? "capacity"
    : s.total >= MAX_UNSETTLED ? "total"
    : s.topRecipientAmount >= MAX_RECIPIENT_UNSETTLED ? "recipient"
    : null;
  if (reason) {
    console.log(`trigger ${reason}: pairs ${s.pairs}, total ${s.total}, top recipient ${s.topRecipientAmount} (queued: ${flushQueued})`);
    requestFlush(reason);
  }
}

// ================= acceptance =================

function acceptVoucher(body: {
  payer: string;
  recipient: string;
  cumulative: string;
  sig: string;
  /** recipient middleware: the price of this request. Refused if the increase is smaller. */
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
  // "underpaid" only makes sense for a new increase. If the increase is <= 0 the
  // voucher is old: let the core give the reason (stale), so a replay shows as one.
  const fresh = v.cumulative - core.accepted(v.payer, v.recipient);
  if (body.min_delta && fresh > 0n && fresh < BigInt(body.min_delta)) {
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
  // Acceptance signature: the contract refuses the voucher without it.
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
  checkTriggers();
  return {
    status: "accepted",
    seq: r.entry.seq,
    delta: r.entry.delta,
    op_sig: r.entry.opSig,
    spendable_after: r.spendableAfter,
  };
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
    unsettledSummary: core.unsettledSummary(),
    stats,
    participants,
  };
}

// ================= x402 facilitator (v2) =================
//
// The resource server (@x402/express paymentMiddleware) calls these endpoints via
// HTTPFacilitatorClient. Request body: { x402Version, paymentPayload, paymentRequirements }.

function supported() {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: SCHEME,
        network: NETWORK,
        // added to the 402 response: the client knows which vault and ledger it pays into.
        extra: { hub: dep.hub, ledger: PUBLIC_URL, operator: dep.operator },
      },
    ],
    extensions: [],
    signers: { "stellar:*": [opKp.publicKey()] },
  };
}

type X402Req = {
  x402Version?: number;
  paymentPayload?: { x402Version?: number; accepted?: Record<string, unknown>; payload?: VoucherPayload };
  paymentRequirements?: Record<string, any>;
};

/** Scheme and requirement checks. Returns the voucher if all is well. */
function parseX402(b: X402Req): { error: string } | { v: VoucherPayload["voucher"]; amount: bigint } {
  const req = b.paymentRequirements;
  const pp = b.paymentPayload;
  if (!req || !pp) return { error: "invalid_request" };
  if (req.scheme !== SCHEME || req.network !== NETWORK) return { error: "unsupported_scheme" };
  if (req.asset !== dep.token) return { error: "wrong_asset" };
  if (req.extra?.hub !== undefined && req.extra.hub !== dep.hub) return { error: "wrong_hub" };
  const acc = pp.accepted ?? {};
  for (const k of ["scheme", "network", "asset", "amount", "payTo"]) {
    if (acc[k] !== req[k]) return { error: "requirements_mismatch" };
  }
  const v = pp.payload?.voucher;
  if (pp.payload?.type !== "voucher" || !v) return { error: "invalid_payload" };
  if (v.recipient !== req.payTo) return { error: "wrong_recipient" };
  if (!/^\d+$/.test(String(req.amount)) || !/^\d+$/.test(String(v.cumulative))) return { error: "bad_amount" };
  return { v, amount: BigInt(req.amount) };
}

/** /verify: READ-ONLY. Would the voucher be accepted right now? */
function x402Verify(b: X402Req) {
  const p = parseX402(b);
  if ("error" in p) return { isValid: false, invalidReason: p.error };
  const v = { payer: p.v.payer, recipient: p.v.recipient, cumulative: BigInt(p.v.cumulative), sig: p.v.signature };
  const e = core.evaluate(v, {
    verifySig: (x, signer) => P.verifyHex(signer, P.voucherHash(hubCfg, x.payer, x.recipient, x.cumulative), x.sig),
  });
  if (!e.ok) return { isValid: false, invalidReason: e.reason, payer: v.payer };
  if (e.delta < p.amount) return { isValid: false, invalidReason: "underpaid", payer: v.payer };
  return { isValid: true, payer: v.payer };
}

/** /settle: ACCEPTS the voucher into the ledger. Nothing goes on chain now; value moves in a batch. */
function x402Settle(b: X402Req) {
  const p = parseX402(b);
  if ("error" in p) return { success: false, errorReason: p.error, transaction: "", network: NETWORK };
  const r = acceptVoucher({
    payer: p.v.payer,
    recipient: p.v.recipient,
    cumulative: p.v.cumulative,
    sig: p.v.signature,
    min_delta: p.amount.toString(),
  });
  if (r.status !== "accepted") {
    return { success: false, errorReason: r.reason, payer: p.v.payer, transaction: "", network: NETWORK };
  }
  const ok = r as { seq: number; delta: bigint; op_sig: string };
  return {
    success: true,
    payer: p.v.payer,
    transaction: "", // no on-chain transaction: value moves in the next batch
    network: NETWORK,
    amount: ok.delta.toString(),
    extra: {
      seq: ok.seq,
      cumulative: p.v.cumulative,
      // with this signature the recipient can settle its voucher without the operator (settle_one)
      operatorSignature: ok.op_sig,
      payerSignature: p.v.signature,
    },
  };
}

/** Resolves when the next batch attempt ends (successful or not). */
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
 * Withdrawal approval (plan par.3.6, v3.3.1).
 *
 *   - Covered by the agent's own on-chain money: IMMEDIATE, no batch. The
 *     vouchers it gave are paid later from what stays in the vault.
 *   - Partly money that has not arrived yet (unsettled incoming vouchers): on
 *     chain that money is still in the payer's balance. Wait for the regular
 *     batch, then sign. NO EXTRA TRANSACTION because of the withdrawal.
 *   - With AUTO_SETTLE off (demo) there is no regular batch: send it now.
 */
async function approveWithdraw(body: { who: string; amount: string; nonce: string; sig: string }) {
  const who = body.who;
  const amount = BigInt(body.amount);
  const nonce = BigInt(body.nonce ?? -1);
  // The requester's signature: without it anyone could reserve and freeze someone else's money.
  const signer = core.signers.get(who);
  if (!signer) return { status: "refused", reason: "not_joined" };
  if (nonce !== (await chain.withdrawNonceOf(who))) return { status: "refused", reason: "bad_nonce" };
  if (!P.verifyHex(signer, P.withdrawRequestHash(hubCfg, who, amount, nonce), String(body.sig ?? ""))) {
    return { status: "refused", reason: "bad_signature" };
  }
  const validUntil = latestLedger + 60;
  const err = core.reserve(who, amount, validUntil, nonce);
  if (err) return { status: "refused", reason: err };
  log({ t: "reserve", who, amount, validUntil, nonce });
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
      await flushUpTo(core.seq, "withdraw");
    }
    if (!core.canApprove(who)) {
      core.release(who, amount);
      log({ t: "release", who, amount, validUntil });
      return { status: "refused", reason: "not_settled_yet" };
    }
  }

  // the nonce was checked in the request; the approval is signed for the same nonce
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

/**
 * Operator endpoints (/, /state, /feed, /flush, /track) ONLY from the same machine.
 * The ledger is the operator's internal system: it shows every payment. For a
 * remote display, set OPERATOR_ONLY=0.
 */
const OPERATOR_ONLY = process.env.OPERATOR_ONLY !== "0";
const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const OPERATOR_PATHS = new Set(["/", "/index.html", "/state", "/feed", "/flush", "/track"]);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(json(body));
  };
  if (OPERATOR_ONLY && OPERATOR_PATHS.has(url.pathname) && !LOCAL.has(req.socket.remoteAddress ?? "")) {
    return send(403, { error: "operator_only" });
  }
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(readFileSync(new URL("../ui/index.html", import.meta.url)));
    }
    if (req.method === "GET" && url.pathname === "/state") return send(200, stateView());
    if (req.method === "GET" && url.pathname === "/supported") return send(200, supported());
    if (req.method === "POST" && url.pathname === "/verify") return send(200, x402Verify(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/settle") {
      // NOTE: the old demo endpoint was also /settle (empty body = "send a batch now").
      // That is /flush now. This endpoint is the x402 facilitator's settle.
      return send(200, x402Settle(await readBody(req)));
    }
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
    if (url.pathname.startsWith("/relay/")) {
      if (!relayer) return send(404, { error: "relay_disabled" });
      if (req.method === "GET" && url.pathname === "/relay/info") {
        return send(200, { address: relayer.address, hub: dep.hub, sppPool: relayer.cfg.sppPool });
      }
      if (req.method !== "POST") return send(404, { error: "not_found" });
      // Hourly limit for outside callers (the operator's own machine is exempt)
      const ip = req.socket.remoteAddress ?? "";
      if (!LOCAL.has(ip) && !relayer.allow(ip)) return send(429, { error: "rate_limited" });
      const b = await readBody(req);
      const out =
        url.pathname === "/relay/spp-sign"
          ? relayer.signSppWithdraw(String(b.xdr ?? ""))
          : url.pathname === "/relay/account"
            ? await relayer.sponsorAccount(String(b.address ?? ""))
            : url.pathname === "/relay/fee-bump"
              ? await relayer.feeBump(String(b.xdr ?? ""))
              : { error: "not_found" };
      if ("error" in out) console.warn(`relay ${url.pathname} refused: ${out.error}`);
      else emit("relay", { path: url.pathname });
      return send("error" in out ? 400 : 200, out);
    }
    if (req.method === "POST" && url.pathname === "/flush") {
      await flushUpTo(core.seq);
      return send(200, stateView());
    }
    if (req.method === "POST" && url.pathname === "/track") {
      // Demo convenience: refresh an address from the chain now (without waiting for events).
      const b = await readBody(req);
      for (const [a, name] of Object.entries(b.labels ?? {})) {
        labels.set(a, String(name));
        log({ t: "label", a, name });
      }
      await locked(() => refresh(b.addresses ?? []));
      return send(200, stateView());
    }
    send(404, { error: "not_found" });
  } catch (e) {
    send(400, { error: String(e) });
  }
});

// ================= startup =================

const loggedKnown = new Set<string>();

async function boot() {
  latestLedger = await chain.latestLedger();
  stats.hubToken = await chain.tokenBalance(dep.hub);
  // Replay the log: chain state first, then unsettled acceptances.
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
        core.reserve(r.who, BigInt(r.amount), r.validUntil, r.nonce !== undefined ? BigInt(r.nonce) : undefined);
      }
      if (r.t === "release") core.release(r.who, BigInt(r.amount));
    }
    for (const a of addrs) known.add(a);
    console.log(`log replayed: seq ${core.seq}, unsettled ${core.entries.length}`);
  }
  logReady = true;
  for (const a of known) if (!loggedKnown.has(a)) log({ t: "known", a });
  // The first event read is not fatal: the watcher repeats every 4 s anyway.
  await locked(watch).catch((e) => console.error("first event read:", (e as Error).message));

  server.listen(PORT, () => {
    console.log(`shadow ledger: http://localhost:${PORT}  hub ${dep.hub}`);
    console.log(`operator: ${opKp.publicKey()}`);
    console.log(relayer ? `relayer (private entry): ${relayer.address}  SPP pool ${relayer.cfg.sppPool}` : "relayer off (no RELAYER_SECRET)");
    console.log(
      AUTO_SETTLE
        ? `batches: every ${ROUND_MS / 1000} s | ${MAX_PAIRS} pairs | total ${Number(MAX_UNSETTLED) / 1e7} | per recipient ${Number(MAX_RECIPIENT_UNSETTLED) / 1e7} (whichever first)`
        : "batches: automatic OFF (AUTO_SETTLE=0), only /flush, exit and withdrawal",
    );
  });

  // watcher: every 4 s
  setInterval(() => {
    void locked(watch)
      .then((exitSeen) => (exitSeen ? flushUpTo(core.seq, "exit") : undefined))
      .catch((e) => console.error("watcher:", e.message));
  }, 4000);
  // time trigger
  if (AUTO_SETTLE) setInterval(() => requestFlush("time"), ROUND_MS);
}

// Startup depends on RPC: a transient network error should not kill the ledger.
async function bootWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await boot();
    } catch (e) {
      if (attempt >= 5) throw e;
      console.error(`startup failed (${attempt}/5): ${String((e as Error).message ?? e).slice(0, 120)}, retrying in 3 s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

bootWithRetry().catch((e) => {
  console.error(e);
  process.exit(1);
});

