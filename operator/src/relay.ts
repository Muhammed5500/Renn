// Relayer: gizli giris icin ucret odeyen hesap (R). Kimsenin parasini tasiyamaz.
//
// Gizli giris akisi (SPP):
//   W (bilinen cuzdan) --deposit--> SPP havuzu --withdraw--> F (taze adres) --> kasa
// F'nin W ile baglantisi kopuk olmali. F'nin hicbir islemi W'den XLM almamali,
// yoksa zincirde W -> F izi kalir. O yuzden F'nin butun ucretlerini R oder:
//
//   1. /relay/spp-sign  SPP cekiminin kaynagi ve odeyeni R (spp --sign-as).
//                       Ispat W'nin makinesinde uretilir, R sadece imzalar.
//   2. /relay/account   F'yi 0 XLM ile acar; rezervi R sponsorlar.
//   3. /relay/fee-bump  F'nin kasa join/deposit islemini R'nin ucretiyle gonderir.
//
// Her uc sadece kendi dar islem sekline imza atar. R'nin imzasi hicbir islemde
// R'nin token'ini ya da baskasinin parasini hareket ettiremez.

import {
  Address,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  FeeBumpTransaction,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import type { Chain } from "@golge-defter/sdk/chain";

export type RelayCfg = {
  passphrase: string;
  hub: string;
  sppPool: string;
  /** Tek islem icin R'nin odeyecegi en fazla ucret (stroop). */
  maxFee: number;
  /** IP basina saatlik istek siniri. */
  perHour: number;
};

type Refusal = { error: string };

const fnName = (s: { toString(): string } | { bytes: Uint8Array }) =>
  "bytes" in s ? Buffer.from(s.bytes).toString() : s.toString();

/** Tek invokeContract islemini ac: [kontrat, fonksiyon, argumanlar, auth]. */
function singleInvoke(tx: Transaction) {
  if (tx.operations.length !== 1) return null;
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  if (op.type !== "invokeHostFunction") return null;
  const f = op.func as unknown as { type: string; value: xdr.InvokeContractArgs & Record<string, any> };
  if (f.type !== "hostFunctionTypeInvokeContract") return null;
  const ic = f.value as any;
  return {
    contract: Address.fromScAddress(ic.contractAddress).toString(),
    fn: fnName(ic.functionName),
    args: ic.args as xdr.ScVal[],
    auth: (op.auth ?? []) as any[],
  };
}

/** Kaynak hesap yetkisiyle imzalanan her auth kokunun izinli cagri olmasi. */
function sourceAuthOnly(auth: any[], contract: string, fns: string[], allowSub: boolean): boolean {
  for (const a of auth) {
    if (a.credentials.type !== "sorobanCredentialsSourceAccount") continue;
    const root = a.rootInvocation;
    if (root.function.type !== "sorobanAuthorizedFunctionTypeContractFn") return false;
    const cf = root.function.value;
    if (Address.fromScAddress(cf.contractAddress).toString() !== contract) return false;
    if (!fns.includes(fnName(cf.functionName))) return false;
    if (!allowSub && root.subInvocations.length > 0) return false;
  }
  return true;
}

export class Relayer {
  kp: Keypair;
  cfg: RelayCfg;
  chain: Chain;
  private hits = new Map<string, number[]>();

  constructor(secret: string, cfg: RelayCfg, chain: Chain) {
    this.kp = Keypair.fromSecret(secret);
    this.cfg = cfg;
    this.chain = chain;
  }

  get address() {
    return this.kp.publicKey();
  }

  /** Saatlik sinir. true = izin. */
  allow(ip: string): boolean {
    const now = Date.now();
    const h = (this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (h.length >= this.cfg.perHour) return false;
    h.push(now);
    this.hits.set(ip, h);
    return true;
  }

  /**
   * SPP cekimini R adina imzala. Sadece: kaynak R, tek islem, bizim havuz,
   * transact, gonderen R, tutar NEGATIF (cekim). Yatirma olsaydi havuz
   * gonderenin (R'nin) token'ini cekerdi.
   */
  signSppWithdraw(txXdr: string): { xdr: string } | Refusal {
    let tx: Transaction;
    try {
      const t = TransactionBuilder.fromXDR(txXdr, this.cfg.passphrase);
      if (t instanceof FeeBumpTransaction) return { error: "fee_bump_not_allowed" };
      tx = t;
    } catch {
      return { error: "bad_xdr" };
    }
    if (tx.source !== this.address) return { error: "source_not_relayer" };
    if (Number(tx.fee) > this.cfg.maxFee) return { error: "fee_too_high" };
    const inv = singleInvoke(tx);
    if (!inv || inv.contract !== this.cfg.sppPool || inv.fn !== "transact" || inv.args.length !== 3) {
      return { error: "not_spp_transact" };
    }
    let ext: any, sender: string;
    try {
      ext = scValToNative(inv.args[1]);
      sender = scValToNative(inv.args[2]);
    } catch {
      return { error: "bad_args" };
    }
    if (sender !== this.address) return { error: "sender_not_relayer" };
    if (!(BigInt(ext.ext_amount) < 0n)) return { error: "not_a_withdrawal" };
    if (!sourceAuthOnly(inv.auth, this.cfg.sppPool, ["transact"], false)) return { error: "bad_auth" };
    tx.sign(this.kp);
    return { xdr: tx.toXDR() };
  }

  /**
   * F'yi 0 XLM ile acan islem: R rezervi sponsorlar. R imzali doner; F kendi
   * imzasini ekleyip gonderir (EndSponsoring F'nin islemi).
   */
  async sponsorAccount(address: string): Promise<{ xdr: string } | Refusal> {
    try {
      Keypair.fromPublicKey(address);
    } catch {
      return { error: "bad_address" };
    }
    const exists = await this.chain.server.getAccount(address).then(
      () => true,
      () => false,
    );
    if (exists) return { error: "account_exists" };
    const acct = await this.chain.server.getAccount(this.address);
    const tx = new TransactionBuilder(acct, { fee: "1000", networkPassphrase: this.cfg.passphrase })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: address }))
      .addOperation(Operation.createAccount({ destination: address, startingBalance: "0" }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: address }))
      .setTimeout(120)
      .build();
    tx.sign(this.kp);
    return { xdr: tx.toXDR() };
  }

  /**
   * F'nin kendi imzaladigi kasa islemini R'nin ucretiyle gonder. Sadece:
   * tek islem, bizim kasa, join ya da deposit, ilk arguman islemin kaynagi
   * (F kendi adina). deposit'in token transferi F'nin kendi parasi.
   */
  async feeBump(innerXdr: string): Promise<{ hash: string } | Refusal> {
    let inner: Transaction;
    try {
      const t = TransactionBuilder.fromXDR(innerXdr, this.cfg.passphrase);
      if (t instanceof FeeBumpTransaction) return { error: "already_fee_bumped" };
      inner = t;
    } catch {
      return { error: "bad_xdr" };
    }
    if (Number(inner.fee) > this.cfg.maxFee) return { error: "fee_too_high" };
    const inv = singleInvoke(inner);
    if (!inv || inv.contract !== this.cfg.hub || !["join", "deposit"].includes(inv.fn)) {
      return { error: "not_vault_join_or_deposit" };
    }
    if (scValToNative(inv.args[0]) !== inner.source) return { error: "not_self" };
    if (inner.source === this.address) return { error: "source_is_relayer" };
    if (!sourceAuthOnly(inv.auth, this.cfg.hub, ["join", "deposit"], true)) return { error: "bad_auth" };
    const bump = TransactionBuilder.buildFeeBumpTransaction(this.kp, "1000", inner, this.cfg.passphrase);
    bump.sign(this.kp);
    const res = await this.chain.submit(bump, `relay ${inv.fn}`);
    return { hash: res.hash };
  }
}
