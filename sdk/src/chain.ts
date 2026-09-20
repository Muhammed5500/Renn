// Chain layer: RPC reads, sending transactions, reading events.
// Used by the ledger server, the SDK and the demo scripts.

import {
  Address,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Transaction,
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

// ---------- ScVal builders ----------

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

/** contracttype struct = ScMap with SORTED keys. */
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

// stellar-sdk 17 changed how XDR objects are read (no .switch()):
// reads go through scValToNative.

export const A = { sym, addr, i128, bytes, u32: (n: number) => nativeToScVal(n, { type: "u32" }), u64: (n: bigint) => nativeToScVal(n, { type: "u64" }) };

// ---------- client ----------

export class Chain {
  cfg: ChainCfg;
  server: rpc.Server;
  /** any existing account, used as the source of read simulations */
  reader: string;
  /**
   * MONOTONIC READ FLOOR. Testnet RPC is several nodes; a lagging node can
   * return the balance from BEFORE a batch or withdrawal we have already seen.
   * With that stale balance the ledger would think a payer holds more than it
   * does. observe(L) raises the floor; a simulation that reads state older
   * than the floor is rejected and retried.
   */
  floor = 0;

  observe(ledger: number) {
    if (ledger > this.floor) this.floor = ledger;
  }

  constructor(cfg: ChainCfg, reader: string) {
    this.cfg = cfg;
    this.server = new rpc.Server(cfg.rpcUrl);
    this.reader = reader;
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Read-only call on the vault contract. Sends no transaction. */
  async read(method: string, args: xdr.ScVal[], contract = this.cfg.hub): Promise<xdr.ScVal> {
    // Network error: retry twice more. A simulation error (contract error) is not retried.
    // Lagging node: retry 10 times, once per second (a ledger is ~5 s).
    let net = 0;
    for (let lag = 0; ; ) {
      try {
        return await this.readOnce(method, args, contract);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("simulation failed")) throw e;
        // "Account not found" for an account that does exist is the same
        // symptom as a lagging node: the read account is simply not in that
        // node's state yet. Give it the same patience.
        if (msg.includes("RPC behind") || msg.includes("Account not found")) {
          if (++lag > 10) throw e;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (++net > 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * net));
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
      throw new Error(`${method} simulation failed: ${(sim as { error?: string }).error}`);
    }
    if (sim.latestLedger < this.floor) {
      throw new Error(`RPC behind: ${sim.latestLedger} < ${this.floor}`);
    }
    return sim.result!.retval;
  }

  async readNative(method: string, args: xdr.ScVal[], contract?: string): Promise<unknown> {
    return scValToNative(await this.read(method, args, contract));
  }

  /** Send a transaction and wait for the result. The return value is an ScVal. */
  async invoke(kp: Keypair, method: string, args: xdr.ScVal[], contract = this.cfg.hub): Promise<{ hash: string; ret: xdr.ScVal | undefined; ledger: number }> {
    const acct = await this.server.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: this.cfg.passphrase })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(60)
      .build();
    try {
      tx = await this.server.prepareTransaction(tx);
    } catch (e) {
      // Testnet RPC is several nodes: right after a confirmation a lagging
      // node can simulate against old state. Wait once and try again.
      console.warn(`${method}: simulation failed, retrying in 2 s (${String(e).slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, 2000));
      tx = await this.server.prepareTransaction(tx);
    }
    tx.sign(kp);
    return this.submit(tx, method);
  }

  /** Send a signed transaction and wait for the result. */
  async submit(tx: Transaction | FeeBumpTransaction, label: string): Promise<{ hash: string; ret: xdr.ScVal | undefined; ledger: number }> {
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`${label} could not be sent: ${sent.hash} ${sent.errorResult?.toXDR("base64") ?? ""}`);
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        this.observe(res.ledger);
        return { hash: sent.hash, ret: res.returnValue, ledger: res.ledger };
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`${label} failed: ${sent.hash}`);
      }
    }
    throw new Error(`${label} timed out: ${sent.hash}`);
  }

  // ---------- vault reads ----------

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

  // ---------- events ----------

  /**
   * Reads vault events. Without `cursor` it starts at `startLedger`.
   * The event name is the first topic (snake_case struct name: deposited, exit_started ...).
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
