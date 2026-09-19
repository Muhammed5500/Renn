// Relayer: the account (R) that pays fees for private entry. It cannot move anyone's money.
//
// Private entry flow (SPP):
//   W (known wallet) --deposit--> SPP pool --withdraw--> F (fresh address) --> vault
// F must stay unlinked from W. None of F's transactions may take XLM from W,
// or the chain would show a W -> F trail. So R pays all of F's fees:
//
//   1. /relay/spp-sign  R is source and fee payer of the SPP withdrawal (spp --sign-as).
//                       The proof is made on W's machine; R only signs.
//   2. /relay/account   Opens F with 0 XLM; R sponsors the reserve.
//   3. /relay/fee-bump  Sends F's vault join/deposit with R paying the fee.
//
// Each endpoint signs only its own narrow transaction shape. In no transaction
// can R's signature move R's tokens or anyone else's money.

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
import type { Chain } from "renn/chain";

export type RelayCfg = {
  passphrase: string;
  hub: string;
  sppPool: string;
  /** Maximum fee R pays for one transaction (stroops). */
  maxFee: number;
  /** Hourly request limit per IP. */
  perHour: number;
};

type Refusal = { error: string };

const fnName = (s: { toString(): string } | { bytes: Uint8Array }) =>
  "bytes" in s ? Buffer.from(s.bytes).toString() : s.toString();

/** Unpack a single invokeContract operation: [contract, function, args, auth]. */
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

/** Every auth root signed with source-account credentials must be an allowed call. */
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

  /** Hourly limit. true = allowed. */
  allow(ip: string): boolean {
    const now = Date.now();
    const h = (this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (h.length >= this.cfg.perHour) return false;
    h.push(now);
    this.hits.set(ip, h);
    return true;
  }

  /**
   * Sign an SPP withdrawal on R's behalf. Only: source R, a single operation,
   * our pool, transact, sender R, NEGATIVE amount (withdrawal). A deposit
   * would make the pool pull the sender's (R's) tokens.
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
   * Transaction that opens F with 0 XLM: R sponsors the reserve. Returned
   * signed by R; F adds its own signature and submits (EndSponsoring is F's
   * operation).
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
   * Submit F's own signed vault transaction with R paying the fee. Only:
   * a single operation, our vault, join or deposit, first argument equal to
   * the transaction source (F on its own behalf). deposit's token transfer is
   * F's own money.
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
