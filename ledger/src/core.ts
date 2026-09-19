// ADIM D2 - Golge defterin beyni. SAF MANTIK.
//
// Ag cagrisi yok, saat okumasi yok, kripto yok. Zaman (ledger, tur) ve imza
// kontrolu disaridan parametre olarak gelir. Ayni girdiye her zaman ayni
// cevap. Bu dosya ileride ZK devresinin sartnamesi olacak (plan par.11).
//
// Plan: Son 2 Plan/PLAN-golge-defter.md par.3.
//
// TEK KURAL (plan par.3.1):
//
//   harcanabilir(x) = zincir_bakiyesi(x) - ayrilmis_cekim(x)
//                   + SUM uzlasmamis_gelen(x) - SUM uzlasmamis_giden(x)
//
// Uzlasmamis tutarlar cift bazinda tutulur:
//   bekleyen(payer, recipient) = son_kabul_kumulatif - zincirde_odenen
//
// Gelen para ANINDA sayilir: geri alma yok, kabul edilmis her fis karsilikli.
//
// Tutarlar bigint, 7 ondalik. number KULLANMA.

export type Addr = string;

export type Scope = {
  /** bos = acik mod. dolu = izin listesi + alici basina KUMULATIF tavan */
  limits: Map<Addr, bigint>;
  /** defterin turu basina bu odeyenin toplam harcama tavani */
  maxPerRound: bigint;
  /** bu ledger'dan sonra kabul yok */
  expiresLedger: number;
};

export type VoucherIn = {
  payer: Addr;
  recipient: Addr;
  cumulative: bigint;
  /** odeyenin imzasi, hex */
  sig: string;
};

/** Kabul edilmis fis. Kabul sirasinin bir halkasi. */
export type Entry = VoucherIn & {
  seq: number;
  /** bu kabulun getirdigi fark */
  delta: bigint;
  /** operatorun kabul imzasi, hex. Cekirdek imzalamaz, sunucu doldurur. */
  opSig?: string;
};

export type Refusal =
  | "not_joined"
  | "bad_signature"
  | "self_payment"
  | "exiting"
  | "stale"
  | "no_scope"
  | "scope_expired"
  | "not_allowlisted"
  | "over_recipient_cap"
  | "over_round_cap"
  | "insufficient_spendable"
  | "bad_amount";

export type AcceptResult =
  | { ok: true; entry: Entry; spendableAfter: bigint }
  | { ok: false; reason: Refusal };

export type Ctx = {
  /** simdiki ledger numarasi (kapsam suresi icin) */
  ledger: number;
  /** defterin tur numarasi (max_per_round icin). Sunucu hesaplar. */
  round: number;
  /** odeyenin imzasini dogrular. Cekirdek kripto bilmez. */
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
  /** bu parti kabul sirasinda bu seq'e kadar olan her seyi kapsiyor */
  uptoSeq: number;
};

export type Reservation = {
  who: Addr;
  amount: bigint;
  validUntil: number;
};

const pk = (payer: Addr, recipient: Addr) => `${payer}|${recipient}`;

export class LedgerCore {
  /** son kabul edilen sira numarasi */
  seq = 0;

  // ---- zincirden gelen gercekler ----
  balances = new Map<Addr, bigint>();
  signers = new Map<Addr, string>();
  scopes = new Map<Addr, Scope>();
  exiting = new Set<Addr>();
  /** zincirdeki paid_between */
  settledCum = new Map<string, bigint>();

  // ---- defterin kendi durumu ----
  /** cift basina son kabul edilen kumulatif */
  lastCum = new Map<string, bigint>();
  /** uzlasmamis kabuller, seq sirali. Onek parti buradan kesilir. */
  entries: Entry[] = [];
  /** cekim onayi icin ayrilmis tutarlar */
  reservations: Reservation[] = [];
  /** odeyen basina bu turda harcanan */
  roundSpent = new Map<Addr, { round: number; spent: bigint }>();
  /** zincire gonderilmis ama sonucu gelmemis parti */
  inflight: Batch | null = null;

  // ================= okuma =================

  balance(x: Addr): bigint {
    return this.balances.get(x) ?? 0n;
  }

  paid(payer: Addr, recipient: Addr): bigint {
    return this.settledCum.get(pk(payer, recipient)) ?? 0n;
  }

  /** son kabul edilen kumulatif (zincirdekinden asagi olamaz) */
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

  /** x'in uzlasmamis giden ve gelen toplamlari */
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

  spendable(x: Addr): bigint {
    const p = this.pending(x);
    return this.balance(x) - this.reserved(x) + p.in - p.out;
  }

  // ================= kabul (plan par.3.2) =================

  /**
   * Fisi kabul eder ya da sebebiyle reddeder. Kabulde durum guncellenir.
   *
   * KONTROL VE GUNCELLEME AYNI SENKRON BLOKTA. Arada await olursa iki fis
   * ayni harcanabilir bakiyeyi gorur ve cift harcama geri gelir (par.3.3).
   */
  accept(v: VoucherIn, ctx: Ctx): AcceptResult {
    const signer = this.signers.get(v.payer);
    if (!signer) return { ok: false, reason: "not_joined" };
    if (v.payer === v.recipient) return { ok: false, reason: "self_payment" };
    if (v.cumulative <= 0n) return { ok: false, reason: "bad_amount" };
    if (!ctx.verifySig(v, signer)) return { ok: false, reason: "bad_signature" };
    if (this.exiting.has(v.payer)) return { ok: false, reason: "exiting" };

    const prev = this.accepted(v.payer, v.recipient);
    if (v.cumulative <= prev) return { ok: false, reason: "stale" };
    const delta = v.cumulative - prev;

    const s = this.scopes.get(v.payer);
    if (!s) return { ok: false, reason: "no_scope" };
    if (ctx.ledger > s.expiresLedger) return { ok: false, reason: "scope_expired" };
    if (s.limits.size > 0) {
      const cap = s.limits.get(v.recipient);
      if (cap === undefined) return { ok: false, reason: "not_allowlisted" };
      if (v.cumulative > cap) return { ok: false, reason: "over_recipient_cap" };
    }
    const rs = this.roundSpent.get(v.payer);
    const spentThisRound = rs && rs.round === ctx.round ? rs.spent : 0n;
    if (spentThisRound + delta > s.maxPerRound) {
      return { ok: false, reason: "over_round_cap" };
    }

    if (this.spendable(v.payer) < delta) {
      return { ok: false, reason: "insufficient_spendable" };
    }

    // ---- kabul ----
    this.seq += 1;
    const entry: Entry = { ...v, seq: this.seq, delta };
    this.entries.push(entry);
    this.lastCum.set(pk(v.payer, v.recipient), v.cumulative);
    this.roundSpent.set(v.payer, { round: ctx.round, spent: spentThisRound + delta });
    return { ok: true, entry, spendableAfter: this.spendable(v.payer) };
  }

  // ================= parti (plan par.3.4) =================

  /**
   * Kabul sirasinin ONEKINI parti olarak keser. Her cift icin onekin icindeki
   * en son kumulatif gider. Parti en fazla maxPairs cift icerir.
   *
   * ONEK DISI PARTI KURMA: her fis kendinden onceki butun kabullerin
   * durumuna gore kontrol edildi, o yuzden sadece onekler odeme gucu
   * acisindan gecerli. Zincirdeki sabit nokta dongusu o zaman kimseyi elemez.
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
      if (!e.opSig) throw new Error(`seq ${e.seq} operator imzasi yok`);
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

  /** Parti zincire gonderildi. Harcanabilir DEGISMEZ, sadece isaret. */
  markInflight(b: Batch): void {
    if (this.inflight) throw new Error("zaten ucusta bir parti var");
    this.inflight = b;
  }

  /** Parti basarisiz oldu: isareti kaldir, fisler sonraki partide denenir. */
  batchFailed(): void {
    this.inflight = null;
  }

  /**
   * Parti zincirde uygulandi. Uzlasmamis tutarlar bakiyeye tasinir;
   * harcanabilir hic kimse icin degismez (test: ucustaki_parti).
   */
  batchSettled(): void {
    const b = this.inflight;
    if (!b) throw new Error("ucusta parti yok");
    for (const it of b.items) {
      const key = pk(it.payer, it.recipient);
      const before = this.settledCum.get(key) ?? 0n;
      if (it.cumulative <= before) continue; // disaridan zaten uzlastirilmis
      const d = it.cumulative - before;
      this.balances.set(it.payer, this.balance(it.payer) - d);
      this.balances.set(it.recipient, this.balance(it.recipient) + d);
      this.settledCum.set(key, it.cumulative);
    }
    this.entries = this.entries.filter((e) => e.seq > b.uptoSeq);
    this.inflight = null;
    this.gc();
  }

  /** Tamamen uzlasmis ciftlerin kaydini temizle. */
  private gc(): void {
    for (const [key, cum] of this.lastCum) {
      if (cum <= (this.settledCum.get(key) ?? 0n)) this.lastCum.delete(key);
    }
  }

  // ================= zincirden gelenler (plan par.D4) =================

  setSigner(x: Addr, pubHex: string): void {
    this.signers.set(x, pubHex);
  }

  setScope(x: Addr, s: Scope): void {
    this.scopes.set(x, s);
  }

  /** Deposited olayi. Bakiye sadece artar. */
  deposited(x: Addr, amount: bigint): void {
    this.balances.set(x, this.balance(x) + amount);
  }

  /** ExitStarted olayi: bu odeyeni artik kabul etme. */
  markExiting(x: Addr): void {
    this.exiting.add(x);
  }

  /**
   * Zincirin gercegi. Bakiyeleri ve cift sayaclarini zincirden alir.
   * Disaridan (kacis yolu, settle_one) uzlastirilmis fislerin kaydi da
   * boylece duser. Ucusta parti varken CAGIRMA.
   */
  reconcile(balances: Map<Addr, bigint>, paid: Map<string, bigint>): void {
    if (this.inflight) throw new Error("ucusta parti varken reconcile yok");
    for (const [x, b] of balances) this.balances.set(x, b);
    for (const [key, p] of paid) this.settledCum.set(key, p);
    this.entries = this.entries.filter(
      (e) => e.cumulative > (this.settledCum.get(pk(e.payer, e.recipient)) ?? 0n),
    );
    this.gc();
  }

  // ================= cekim onayi (plan par.3.6) =================

  /**
   * Cekim icin para ayirir. Bu andan itibaren yeni fisler bu parayi
   * harcayamaz. Sunucu sonra x'in fislerini kapsayan parti gonderir,
   * onaydan sonra imzalar.
   */
  reserve(who: Addr, amount: bigint, validUntil: number): Refusal | null {
    if (!this.signers.has(who)) return "not_joined";
    if (amount <= 0n) return "bad_amount";
    if (this.spendable(who) < amount) return "insufficient_spendable";
    this.reservations.push({ who, amount, validUntil });
    return null;
  }

  /** Withdrawn olayi (path: approved). Bakiye ve ayrilan tutar birlikte duser. */
  withdrawn(who: Addr, amount: bigint): void {
    this.balances.set(who, this.balance(who) - amount);
    const i = this.reservations.findIndex((r) => r.who === who && r.amount === amount);
    if (i >= 0) this.reservations.splice(i, 1);
  }

  /** Suresi dolmus, kullanilmamis ayirmalari serbest birak. */
  expireReservations(ledger: number): void {
    this.reservations = this.reservations.filter((r) => r.validUntil >= ledger);
  }

  // ================= kalicilik =================

  /**
   * Log'dan geri yukleme: daha once KABUL EDILMIS bir kaydi kontrolsuz geri
   * koyar. Zincirde zaten uzlasmis olanlar sessizce atlanir. Sadece sunucu
   * acilisinda, zincir durumu yuklendikten SONRA cagir.
   */
  restore(e: Entry): void {
    if (e.seq > this.seq) this.seq = e.seq;
    if (e.cumulative <= this.paid(e.payer, e.recipient)) return;
    this.entries.push(e);
    const key = pk(e.payer, e.recipient);
    if (e.cumulative > (this.lastCum.get(key) ?? 0n)) this.lastCum.set(key, e.cumulative);
  }
}

export { pk as pairKey };
