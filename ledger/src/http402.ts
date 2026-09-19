// ADIM S - Tasima katmani. Fis HTTP ustunde gidiyor, x402'nin seklini takip
// ediyor, yeni bir sema olarak ("tab-v1").
//
//   // hizmet satan taraf
//   server.on("request", tab({ ledger, hub, recipient: ME, price: 200_000n }, handler))
//
//   // ajan yazan taraf
//   const fetch = wrapFetch(agent)   // ajan bundan sonra normal fetch kullaniyor
//
// Akis:
//   1. Fissiz istek -> 402 + accepts: [{ scheme: "tab-v1", hub, payTo, price, ledger }]
//   2. Ajan fisi imzalar, X-Tab-Voucher basliginda tekrar gonderir
//   3. Alici ara katmani fisi DEFTERE ASAR (odeyen degil, alici). Kabul edilirse
//      hizmet verilir. Boylece odeyen bir fisi defterden saklayamaz.
//
// Alicinin zincirle hic konusmasina gerek yok: v3.2'nin sekiz maddelik on
// kontrolu tek bir defter cagrisi.

import type http from "node:http";
import type { Agent } from "./agent.ts";

export const SCHEME = "tab-v1";
export const HEADER = "x-tab-voucher";

export type Offer = {
  scheme: typeof SCHEME;
  network: string;
  hub: string;
  payTo: string;
  /** bu istegin bedeli, 7 ondalikli tam sayi, metin */
  price: string;
  ledger: string;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

// ================= hizmet satan taraf =================

export type TabOptions = {
  ledger: string;
  hub: string;
  recipient: string;
  price: bigint;
  network?: string;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** node:http icin sarmalayici. Kabul edilmeyen istek handler'a hic ulasmaz. */
export function tab(o: TabOptions, handler: Handler): Handler {
  const offer: Offer = {
    scheme: SCHEME,
    network: o.network ?? "stellar:testnet",
    hub: o.hub,
    payTo: o.recipient,
    price: o.price.toString(),
    ledger: o.ledger,
  };
  const refuse = (res: http.ServerResponse, reason: string) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, error: reason, accepts: [offer] }));
  };

  return async (req, res) => {
    const h = req.headers[HEADER];
    if (!h || Array.isArray(h)) return refuse(res, "payment_required");
    let v: { payer: string; recipient: string; cumulative: string; sig: string };
    try {
      v = JSON.parse(unb64(h));
    } catch {
      return refuse(res, "bad_voucher");
    }
    if (v.recipient !== o.recipient) return refuse(res, "wrong_recipient");

    const r = await fetch(`${o.ledger}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...v, min_delta: o.price.toString() }),
    });
    const j = (await r.json()) as { status: string; reason?: string; seq?: number };
    if (j.status !== "accepted") return refuse(res, j.reason ?? "refused");
    res.setHeader("x-tab-receipt", String(j.seq));
    handler(req, res);
  };
}

// ================= ajan yazan taraf =================

export type WrapOptions = {
  /** Istek basina odenebilecek en yuksek bedel. Odeme basina tavan SDK'da,
   *  imzalama aninda uygulanir (plan v3.2 par.8.5). */
  maxPrice?: bigint;
  fetchImpl?: typeof fetch;
};

/**
 * fetch'i sarar. 402 + tab-v1 teklifi gelirse fisi imzalar ve istegi tekrar
 * eder. Ajanin kodu normal fetch kullanir.
 */
export function wrapFetch(agent: Agent, w: WrapOptions = {}): typeof fetch {
  const f = w.fetchImpl ?? fetch;
  return async (input, init) => {
    const first = await f(input, init);
    if (first.status !== 402) return first;
    const body = (await first.clone().json().catch(() => null)) as { accepts?: Offer[] } | null;
    const offer = body?.accepts?.find((a) => a.scheme === SCHEME && a.hub === agent.hub.hub);
    if (!offer) return first;
    const price = BigInt(offer.price);
    if (w.maxPrice !== undefined && price > w.maxPrice) return first;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!agent.cum.has(offer.payTo)) await agent.sync(offer.payTo);
      const v = agent.voucher(offer.payTo, price);
      const headers = new Headers(init?.headers);
      headers.set(HEADER, b64(JSON.stringify(v)));
      const r = await f(input, { ...init, headers });
      if (r.status !== 402) {
        if (r.ok) agent.cum.set(offer.payTo, BigInt(v.cumulative));
        return r;
      }
      // Es zamanli istekler ayni kumulatifi kullanmis olabilir: defterden
      // toparlan, bir kez daha dene.
      const err = (await r.clone().json().catch(() => null)) as { error?: string } | null;
      if (err?.error !== "stale") return r;
      await agent.sync(offer.payTo);
    }
    return first;
  };
}
