// STEP D2 - The shadow ledger's brain. PURE LOGIC.
//
// No network calls, no clock reads, no crypto. Signature checks come in as a
// parameter. The same input always gives the same answer. This file is meant
// to become the spec of a ZK circuit later (plan par.11).
//
// Plan: PLAN-golge-defter.md (outside the repo, one level above Proje/) par.3.
//
// THE ONE RULE (plan par.3.1):
//
//   spendable(x) = onchain_balance(x) - reserved_withdrawals(x)
//                + SUM unsettled_incoming(x) - SUM unsettled_outgoing(x)
//
// Unsettled amounts are kept per pair:
//   pending(payer, recipient) = last_accepted_cumulative - paid_onchain
//
// Incoming money counts IMMEDIATELY: there is no clawback, and every accepted
// voucher is backed.
//
// Amounts are bigint, 7 decimals. Do NOT use number.

export type Addr = string;

export type VoucherIn = {
  payer: Addr;
  recipient: Addr;
  cumulative: bigint;
  /** payer's signature, hex */
  sig: string;
};

/** An accepted voucher. One link in the acceptance order. */
export type Entry = VoucherIn & {
  seq: number;
  /** the increase this acceptance adds */
  delta: bigint;
  /** operator's acceptance signature, hex. The core does not sign; the server fills it in. */
  opSig?: string;
};

export type Refusal =
  | "not_joined"
  | "bad_signature"
  | "self_payment"
  | "exiting"
  | "stale"
  | "insufficient_spendable"
  | "bad_amount";

export type AcceptResult =
  | { ok: true; entry: Entry; spendableAfter: bigint }
  | { ok: false; reason: Refusal };

export type Ctx = {
  /** verifies the payer's signature. The core knows no crypto. */
  verifySig: (v: VoucherIn, signerHex: string) => boolean;
};

export type BatchItem = {
  payer: Addr;
  recipient: Addr;
  cumulative: bigint;
  sig: string;
  opSig: string;
};

export type Batch = {
  items: BatchItem[];
  /** this batch covers everything up to this seq in the acceptance order */
  uptoSeq: number;
};

export type Reservation = {
  who: Addr;
  amount: bigint;
  validUntil: number;
  /** withdrawal request nonce: the same request cannot reserve twice */
  nonce?: bigint;
};

const pk = (payer: Addr, recipient: Addr) => `${payer}|${recipient}`;

export class LedgerCore {
  /** last accepted sequence number */
  seq = 0;

  // ---- facts from the chain ----
  balances = new Map<Addr, bigint>();
  signers = new Map<Addr, string>();
  exiting = new Set<Addr>();
  /** paid_between on chain */
  settledCum = new Map<string, bigint>();

  // ---- the ledger's own state ----
  /** last accepted cumulative per pair */
  lastCum = new Map<string, bigint>();
  /** unsettled acceptances, in seq order. Prefix batches are cut from here. */
  entries: Entry[] = [];
  /** amounts reserved for withdrawal approval */
  reservations: Reservation[] = [];
  /** batch sent to the chain whose result has not arrived yet */
  inflight: Batch | null = null;

  // ================= reads =================

  balance(x: Addr): bigint {
    return this.balances.get(x) ?? 0n;
  }

  paid(payer: Addr, recipient: Addr): bigint {
    return this.settledCum.get(pk(payer, recipient)) ?? 0n;
  }

  /** last accepted cumulative (never below the on-chain value) */
  accepted(payer: Addr, recipient: Addr): bigint {
    const a = this.lastCum.get(pk(payer, recipient)) ?? 0n;
    const s = this.paid(payer, recipient);
    return a > s ? a : s;
  }

  reserved(x: Addr): bigint {
    let r = 0n;
    for (const res of this.reservations) if (res.who === x) r += res.amount;
    return r;
  }

  /** x's unsettled outgoing and incoming totals */
  pending(x: Addr): { out: bigint; in: bigint } {
    let out = 0n;
    let inn = 0n;
    for (const [key, cum] of this.lastCum) {
      const [payer, recipient] = key.split("|");
      const d = cum - (this.settledCum.get(key) ?? 0n);
      if (d <= 0n) continue;
      if (payer === x) out += d;
      if (recipient === x) inn += d;
    }
    return { out, in: inn };
  }

  /**
   * Summary for the batch triggers: number of DISTINCT unsettled pairs (the
   * per-transaction limit counts pairs, not vouchers), total unsettled
   * amount, and the recipient with the largest pending amount. Includes the
   * batch in flight.
   */
  unsettledSummary(): { pairs: number; total: bigint; topRecipient: Addr | null; topRecipientAmount: bigint } {
    let pairs = 0;
    let total = 0n;
    const perRecipient = new Map<Addr, bigint>();
    for (const [key, cum] of this.lastCum) {
      const d = cum - (this.settledCum.get(key) ?? 0n);
      if (d <= 0n) continue;
      pairs += 1;
      total += d;
      const r = key.split("|")[1];
      perRecipient.set(r, (perRecipient.get(r) ?? 0n) + d);
    }
    let topRecipient: Addr | null = null;
    let topRecipientAmount = 0n;
    for (const [r, a] of perRecipient) {
      if (a > topRecipientAmount) {
        topRecipient = r;
        topRecipientAmount = a;
      }
    }
    return { pairs, total, topRecipient, topRecipientAmount };
  }

  spendable(x: Addr): bigint {
    const p = this.pending(x);
    return this.balance(x) - this.reserved(x) + p.in - p.out;
  }

  // ================= acceptance (plan par.3.2) =================

  /**
   * Accepts the voucher or refuses it with a reason. State is updated on acceptance.
   *
   * CHECK AND UPDATE IN THE SAME SYNCHRONOUS BLOCK. With an await in between,
   * two vouchers would see the same spendable balance and double spending
   * would come back (par.3.3).
   */
  accept(v: VoucherIn, ctx: Ctx): AcceptResult {
    const e = this.evaluate(v, ctx);
    if (!e.ok) return e;

    // ---- accept ----
    this.seq += 1;
    const entry: Entry = { ...v, seq: this.seq, delta: e.delta };
    this.entries.push(entry);
    this.lastCum.set(pk(v.payer, v.recipient), v.cumulative);
    return { ok: true, entry, spendableAfter: this.spendable(v.payer) };
  }

  /**
   * accept()'s checks, CHANGING NOTHING. x402's /verify endpoint uses this
   * (spec: verify must be read-only).
   */
  evaluate(v: VoucherIn, ctx: Ctx): { ok: true; delta: bigint } | { ok: false; reason: Refusal } {
    const signer = this.signers.get(v.payer);
    if (!signer) return { ok: false, reason: "not_joined" };
    if (v.payer === v.recipient) return { ok: false, reason: "self_payment" };
    if (v.cumulative <= 0n) return { ok: false, reason: "bad_amount" };
    if (!ctx.verifySig(v, signer)) return { ok: false, reason: "bad_signature" };
    if (this.exiting.has(v.payer)) return { ok: false, reason: "exiting" };

    const prev = this.accepted(v.payer, v.recipient);
    if (v.cumulative <= prev) return { ok: false, reason: "stale" };
    const delta = v.cumulative - prev;

    if (this.spendable(v.payer) < delta) {
      return { ok: false, reason: "insufficient_spendable" };
    }
    return { ok: true, delta };
  }

  // ================= batches (plan par.3.4) =================

  /**
   * Cuts a PREFIX of the acceptance order as a batch. For each pair, the
   * latest cumulative within the prefix is sent. A batch holds at most
   * maxPairs pairs.
   *
   * NEVER BUILD A NON-PREFIX BATCH: each voucher was checked against the state
   * after all earlier acceptances, so only prefixes are guaranteed solvent.
   * Then the on-chain fixed-point loop never drops anyone.
   */
  cutBatch(maxPairs: number): Batch | null {
    const latest = new Map<string, Entry>();
    let upto = 0;
    for (const e of this.entries) {
      if (this.inflight && e.seq <= this.inflight.uptoSeq) continue;
      const key = pk(e.payer, e.recipient);
      if (!latest.has(key) && latest.size >= maxPairs) break;
      latest.set(key, e);
      upto = e.seq;
    }
    if (latest.size === 0) return null;
    const items: BatchItem[] = [];
    for (const e of latest.values()) {
      if (!e.opSig) throw new Error(`seq ${e.seq} has no operator signature`);
      items.push({
        payer: e.payer,
        recipient: e.recipient,
        cumulative: e.cumulative,
        sig: e.sig,
        opSig: e.opSig,
      });
    }
    return { items, uptoSeq: upto };
  }

  /** Batch sent to the chain. Spendable does NOT change; this is only a marker. */
  markInflight(b: Batch): void {
    if (this.inflight) throw new Error("a batch is already in flight");
    this.inflight = b;
  }

  /** Batch failed: clear the marker; the vouchers go into the next batch. */
  batchFailed(): void {
    this.inflight = null;
  }

  /**
   * Batch applied on chain. Unsettled amounts move into balances; nobody's
   * spendable changes (test: batch_in_flight).
   */
  batchSettled(): void {
    const b = this.inflight;
    if (!b) throw new Error("no batch in flight");
    for (const it of b.items) {
      const key = pk(it.payer, it.recipient);
      const before = this.settledCum.get(key) ?? 0n;
      if (it.cumulative <= before) continue; // already settled from outside
      const d = it.cumulative - before;
      this.balances.set(it.payer, this.balance(it.payer) - d);
      this.balances.set(it.recipient, this.balance(it.recipient) + d);
      this.settledCum.set(key, it.cumulative);
    }
    this.entries = this.entries.filter((e) => e.seq > b.uptoSeq);
    this.inflight = null;
    this.gc();
  }

  /** Drop the records of fully settled pairs. */
  private gc(): void {
    for (const [key, cum] of this.lastCum) {
      if (cum <= (this.settledCum.get(key) ?? 0n)) this.lastCum.delete(key);
    }
  }

  // ================= from the chain (plan par.D4) =================

  setSigner(x: Addr, pubHex: string): void {
    this.signers.set(x, pubHex);
  }

  /** Deposited event. The balance only goes up. */
  deposited(x: Addr, amount: bigint): void {
    this.balances.set(x, this.balance(x) + amount);
  }

  /** ExitStarted event: stop accepting this payer. */
  markExiting(x: Addr): void {
    this.exiting.add(x);
  }

  /**
   * The chain's truth. Takes balances and pair counters from the chain.
   * Records of vouchers settled from outside (escape hatch, settle_one) are
   * dropped this way too. Do NOT call while a batch is in flight.
   */
  reconcile(balances: Map<Addr, bigint>, paid: Map<string, bigint>): void {
    if (this.inflight) throw new Error("no reconcile while a batch is in flight");
    for (const [x, b] of balances) this.balances.set(x, b);
    // paid_between on chain is monotonic: a smaller reading is stale, ignore it.
    for (const [key, p] of paid) {
      if (p > (this.settledCum.get(key) ?? 0n)) this.settledCum.set(key, p);
    }
    this.entries = this.entries.filter(
      (e) => e.cumulative > (this.settledCum.get(pk(e.payer, e.recipient)) ?? 0n),
    );
    this.gc();
  }

  // ================= withdrawal approval (plan par.3.6) =================

  /**
   * Reserves money for a withdrawal. From now on new vouchers cannot spend
   * it. Any amount within the spendable balance can be reserved.
   *
   * If canApprove() is true after reserving, the server signs the approval
   * IMMEDIATELY (the common case, no batch). Otherwise part of the withdrawal
   * is money that has not arrived yet: the server waits for the regular
   * batch, then signs.
   */
  reserve(who: Addr, amount: bigint, validUntil: number, nonce?: bigint): Refusal | "duplicate_request" | null {
    if (!this.signers.has(who)) return "not_joined";
    if (amount <= 0n) return "bad_amount";
    if (nonce !== undefined && this.reservations.some((r) => r.who === who && r.nonce === nonce)) {
      return "duplicate_request";
    }
    if (this.spendable(who) < amount) return "insufficient_spendable";
    this.reservations.push({ who, amount, validUntil, nonce });
    return null;
  }

  /**
   * Amount withdrawable NOW, without a batch: on-chain balance minus the
   * unsettled vouchers it gave, minus reserved withdrawals. Money still to
   * arrive (incoming vouchers) does NOT count: on chain it is still in the
   * payer's balance.
   *
   * Withdrawing up to this amount is safe: afterwards the vault still holds
   * at least the total of the vouchers it gave, and those get paid whichever
   * batch they go into.
   */
  withdrawableNow(x: Addr): bigint {
    const w = this.balance(x) - this.reserved(x) - this.pending(x).out;
    return w > 0n ? w : 0n;
  }

  /**
   * Are all of x's reserved withdrawals covered by its on-chain balance?
   * If so, the operator approval can be signed WITHOUT WAITING FOR A BATCH.
   */
  canApprove(x: Addr): boolean {
    return this.balance(x) - this.reserved(x) - this.pending(x).out >= 0n;
  }

  /** If the approval can never be given (expired, wait over), undo the reservation. */
  release(who: Addr, amount: bigint): void {
    const i = this.reservations.findIndex((r) => r.who === who && r.amount === amount);
    if (i >= 0) this.reservations.splice(i, 1);
  }

  /** Withdrawn event (path: approved). Balance and reservation drop together. */
  withdrawn(who: Addr, amount: bigint): void {
    this.balances.set(who, this.balance(who) - amount);
    const i = this.reservations.findIndex((r) => r.who === who && r.amount === amount);
    if (i >= 0) this.reservations.splice(i, 1);
  }

  /** Release expired, unused reservations. */
  expireReservations(ledger: number): void {
    this.reservations = this.reservations.filter((r) => r.validUntil >= ledger);
  }

  // ================= persistence =================

  /**
   * Restore from the log: puts back a previously ACCEPTED record without
   * checks. Records already settled on chain are skipped silently. Call only
   * at server startup, AFTER the chain state is loaded.
   */
  restore(e: Entry): void {
    if (this.entries.some((x) => x.seq === e.seq)) return; // loading twice is harmless
    if (e.seq > this.seq) this.seq = e.seq;
    if (e.cumulative <= this.paid(e.payer, e.recipient)) return;
    this.entries.push(e);
    const key = pk(e.payer, e.recipient);
    if (e.cumulative > (this.lastCum.get(key) ?? 0n)) this.lastCum.set(key, e.cumulative);
  }
}

export { pk as pairKey };
