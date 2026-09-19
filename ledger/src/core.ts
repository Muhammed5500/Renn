// ADIM D2 - Golge defterin beyni. SAF MANTIK.
//
// Ag cagrisi yok, saat okumasi yok, kripto yok. Imza kontrolu disaridan
// parametre olarak gelir. Ayni girdiye her zaman ayni
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
  | "insufficient_spendable"
  | "bad_amount";

export type AcceptResult =
  | { ok: true; entry: Entry; spendableAfter: bigint }
  | { ok: false; reason: Refusal };

export type Ctx = {
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
  /** cekim isteginin nonce'u: ayni istek iki kez ayirma yapamaz */
  nonce?: bigint;
};

const pk = (payer: Addr, recipient: Addr) => `${payer}|${recipient}`;

export class LedgerCore {
  /** son kabul edilen sira numarasi */
  seq = 0;

  // ---- zincirden gelen gercekler ----
  balances = new Map<Addr, bigint>();
  signers = new Map<Addr, string>();
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

  /**
   * Parti tetikleyicileri icin ozet: uzlasmamis FARKLI cift sayisi (islem
   * basina sinir cift sayisiyla, fis sayisiyla degil), uzlasmamis toplam
   * tutar ve en cok bekleyen alacagi olan alici. Ucustaki parti dahil.
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

  // ================= kabul (plan par.3.2) =================

  /**
   * Fisi kabul eder ya da sebebiyle reddeder. Kabulde durum guncellenir.
   *
   * KONTROL VE GUNCELLEME AYNI SENKRON BLOKTA. Arada await olursa iki fis
   * ayni harcanabilir bakiyeyi gorur ve cift harcama geri gelir (par.3.3).
   */
  accept(v: VoucherIn, ctx: Ctx): AcceptResult {
    const e = this.evaluate(v, ctx);
    if (!e.ok) return e;

    // ---- kabul ----
    this.seq += 1;
    const entry: Entry = { ...v, seq: this.seq, delta: e.delta };
    this.entries.push(entry);
    this.lastCum.set(pk(v.payer, v.recipient), v.cumulative);
    return { ok: true, entry, spendableAfter: this.spendable(v.payer) };
  }

  /**
   * accept()'in kontrollerinin HICBIR SEY DEGISTIRMEYEN hali. x402'nin
   * /verify ucu bunu kullanir (spec: verify salt okunur olmali).
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
    // Zincirdeki paid_between monoton: daha kucuk bir okuma eskidir, yok say.
    for (const [key, p] of paid) {
      if (p > (this.settledCum.get(key) ?? 0n)) this.settledCum.set(key, p);
    }
    this.entries = this.entries.filter(
      (e) => e.cumulative > (this.settledCum.get(pk(e.payer, e.recipient)) ?? 0n),
    );
    this.gc();
  }

  // ================= cekim onayi (plan par.3.6) =================

  /**
   * Cekim icin para ayirir. Bu andan itibaren yeni fisler bu parayi
   * harcayamaz. Harcanabilir bakiyenin icindeki her tutar ayrilabilir.
   *
   * Ayirmadan sonra canApprove() dogruysa sunucu onayi HEMEN imzalar (yaygin
   * durum, parti yok). Degilse cekimin bir kismi henuz gelmemis paradan
   * olusuyor: sunucu olagan partiyi bekler, sonra imzalar.
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
   * Partisiz, SIMDI cekilebilecek tutar: zincirdeki bakiye eksi verdigi ama
   * uzlasmamis fisler eksi ayrilmis cekimler. Gelmesi beklenen para (gelen
   * fisler) SAYILMAZ: o para zincirde hala odeyenin bakiyesinde duruyor.
   *
   * Bu tutara kadar cekim guvenli: cekimden sonra kasada en az verdigi
   * fislerin toplami kaliyor, o fisler hangi partiye girerse girsin odenir.
   */
  withdrawableNow(x: Addr): bigint {
    const w = this.balance(x) - this.reserved(x) - this.pending(x).out;
    return w > 0n ? w : 0n;
  }

  /**
   * x'in ayrilmis cekimlerinin hepsi zincirdeki bakiyesiyle karsilaniyor mu.
   * Evetse operator onayi PARTI BEKLEMEDEN imzalanabilir.
   */
  canApprove(x: Addr): boolean {
    return this.balance(x) - this.reserved(x) - this.pending(x).out >= 0n;
  }

  /** Onay hic verilemeyecekse (sure doldu, bekleme bitti) ayirmayi geri al. */
  release(who: Addr, amount: bigint): void {
    const i = this.reservations.findIndex((r) => r.who === who && r.amount === amount);
    if (i >= 0) this.reservations.splice(i, 1);
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
    if (this.entries.some((x) => x.seq === e.seq)) return; // iki kez yukleme zararsiz
    if (e.seq > this.seq) this.seq = e.seq;
    if (e.cumulative <= this.paid(e.payer, e.recipient)) return;
    this.entries.push(e);
    const key = pk(e.payer, e.recipient);
    if (e.cumulative > (this.lastCum.get(key) ?? 0n)) this.lastCum.set(key, e.cumulative);
  }
}

export { pk as pairKey };
