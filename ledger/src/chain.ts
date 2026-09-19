// Zincir katmani: RPC okuma, islem gonderme, olay okuma.
// Hem defter sunucusu hem demo scriptleri kullaniyor.

import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export type ChainCfg = {
  rpcUrl: string;
  passphrase: string;
  hub: string;
  token: string;
};

export const TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

export type VoucherArg = {
  payer: string;
  recipient: string;
  cumulative: bigint;
  sig: string; // hex
  opSig: string; // hex
};

// ---------- ScVal kurucular ----------

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

/** contracttype struct = anahtarlari SIRALI ScMap. */
function struct(fields: [string, xdr.ScVal][]): xdr.ScVal {
  const sorted = [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(sorted.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
}

export function voucherScVal(v: VoucherArg): xdr.ScVal {
  return struct([
    ["payer", addr(v.payer)],
    ["recipient", addr(v.recipient)],
    ["cumulative", i128(v.cumulative)],
    ["sig", bytes(v.sig)],
    ["op_sig", bytes(v.opSig)],
  ]);
}

// stellar-sdk 17'de XDR nesnelerinin okuma arayuzu degisti (.switch() yok):
// okumalar scValToNative ile yapiliyor.

export const A = { sym, addr, i128, bytes, u32: (n: number) => nativeToScVal(n, { type: "u32" }), u64: (n: bigint) => nativeToScVal(n, { type: "u64" }) };

// ---------- istemci ----------

export class Chain {
  cfg: ChainCfg;
  server: rpc.Server;
  /** okuma simulasyonlari icin var olan herhangi bir hesap */
  reader: string;

  constructor(cfg: ChainCfg, reader: string) {
    this.cfg = cfg;
    this.server = new rpc.Server(cfg.rpcUrl);
    this.reader = reader;
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Kasa kontratinda salt okuma. Islem gondermez. */
  async read(method: string, args: xdr.ScVal[], contract = this.cfg.hub): Promise<xdr.ScVal> {
    // Ag hatasinda iki kez daha dene. Simulasyon hatasi (kontrat hatasi) denenmez.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readOnce(method, args, contract);
      } catch (e) {
        if (attempt >= 2 || String(e).includes("simulasyonu basarisiz")) throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  private async readOnce(method: string, args: xdr.ScVal[], contract: string): Promise<xdr.ScVal> {
    const acct = await this.server.getAccount(this.reader);
    const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: this.cfg.passphrase })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`${method} simulasyonu basarisiz: ${(sim as { error?: string }).error}`);
    }
    return sim.result!.retval;
  }

  async readNative(method: string, args: xdr.ScVal[], contract?: string): Promise<unknown> {
    return scValToNative(await this.read(method, args, contract));
  }

  /** Islem gonder, sonucu bekle. Donus degeri ScVal. */
  async invoke(kp: Keypair, method: string, args: xdr.ScVal[], contract = this.cfg.hub): Promise<{ hash: string; ret: xdr.ScVal | undefined; ledger: number }> {
    const acct = await this.server.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: this.cfg.passphrase })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(60)
      .build();
    tx = await this.server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`${method} gonderilemedi: ${sent.hash}`);
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash: sent.hash, ret: res.returnValue, ledger: res.ledger };
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`${method} basarisiz: ${sent.hash}`);
      }
    }
    throw new Error(`${method} zaman asimi: ${sent.hash}`);
  }

  // ---------- kasa okumalari ----------

  async balanceOf(who: string): Promise<bigint> {
    return BigInt((await this.readNative("balance_of", [addr(who)])) as bigint);
  }

  async paidBetween(p: string, r: string): Promise<bigint> {
    return BigInt((await this.readNative("paid_between", [addr(p), addr(r)])) as bigint);
  }

  async signerOf(who: string): Promise<string | null> {
    const v = scValToNative(await this.read("signer_of", [addr(who)])) as Uint8Array | null | undefined;
    return v ? Buffer.from(v).toString("hex") : null;
  }

  async exitAtOf(who: string): Promise<number | null> {
    const v = await this.readNative("exit_at_of", [addr(who)]);
    return v === null || v === undefined ? null : Number(v);
  }

  async withdrawNonceOf(who: string): Promise<bigint> {
    return BigInt((await this.readNative("withdraw_nonce_of", [addr(who)])) as bigint);
  }

  async tokenBalance(who: string): Promise<bigint> {
    return BigInt((await this.readNative("balance", [addr(who)], this.cfg.token)) as bigint);
  }

  // ---------- olaylar ----------

  /**
   * Kasa olaylarini okur. `cursor` yoksa `startLedger`'dan baslar.
   * Olay adi ilk topic (snake_case struct adi: deposited, exit_started ...).
   */
  async events(from: { cursor?: string; startLedger?: number }): Promise<{
    events: { name: string; topics: unknown[]; data: Record<string, unknown>; ledger: number; tx: string }[];
    cursor: string;
    latest: number;
  }> {
    const filters = [{ type: "contract" as const, contractIds: [this.cfg.hub] }];
    const req = from.cursor
      ? { cursor: from.cursor, filters, limit: 200 }
      : { startLedger: from.startLedger!, filters, limit: 200 };
    const res = await this.server.getEvents(req as rpc.Api.GetEventsRequest);
    const events = res.events.map((e) => {
      const topics = e.topic.map((t) => scValToNative(t));
      const data = scValToNative(e.value) as Record<string, unknown>;
      return { name: String(topics[0]), topics: topics.slice(1), data, ledger: e.ledger, tx: e.txHash };
    });
    return { events, cursor: res.cursor, latest: res.latestLedger };
  }
}
