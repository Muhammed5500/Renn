// Gizli giris, ajan (F) tarafi. F'nin XLM'i yok ve hic olmayacak: hesabini
// relayer sponsorlar, islem ucretlerini relayer oder. F'nin zincirdeki hicbir
// izi, SPP havuzuna yatiran bilinen cuzdana (W) gitmez.
//
// SPP adimi (W -> havuz -> F) resmi SPP CLI ile yapilir, bkz. spp-shim/.

import { Contract, Keypair, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import type { Chain } from "./chain.ts";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok || j.error) throw new Error(`${url}: ${j.error ?? r.status}`);
  return j;
}

/** F'yi 0 XLM ile ac. Rezervi relayer sponsorlar; F sadece kendi kismini imzalar. */
export async function openSponsored(relayUrl: string, f: Keypair, chain: Chain) {
  const { xdr: x } = await post(`${relayUrl}/relay/account`, { address: f.publicKey() });
  const tx = TransactionBuilder.fromXDR(x, chain.cfg.passphrase);
  tx.sign(f);
  return chain.submit(tx, "hesap ac");
}

/** F'nin kasa islemi (join, deposit), ucreti relayer oder (fee-bump). */
export async function relayedInvoke(relayUrl: string, f: Keypair, chain: Chain, method: string, args: xdr.ScVal[]) {
  const acct = await chain.server.getAccount(f.publicKey());
  let tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: chain.cfg.passphrase })
    .addOperation(new Contract(chain.cfg.hub).call(method, ...args))
    .setTimeout(60)
    .build();
  tx = await chain.server.prepareTransaction(tx);
  tx.sign(f);
  const { hash } = await post(`${relayUrl}/relay/fee-bump`, { xdr: tx.toXDR() });
  // relayer bekleyip dondu; okuma tabanini bu islemin ledger'ina tasimak icin
  const res = await chain.server.getTransaction(hash);
  if ("ledger" in res && res.ledger) chain.observe(res.ledger);
  return { hash };
}
