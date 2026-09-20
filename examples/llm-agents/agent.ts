// One agent: sells an endpoint over x402, and on its own schedule decides what
// to buy from the others. Both decisions and answers come from Claude.

import express from "express";
import { Agent, Chain, BatchSettlementStellarClient, BatchSettlementStellarServer } from "rennpay";
import { x402Client } from "@x402/core/client";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware } from "@x402/express";
import { ask, askJson } from "./llm.ts";
import { PERSONAS, byId, type Persona } from "./personas.ts";
import { dep, LEDGER, setup, fmt } from "./identity.ts";

const NETWORK = "stellar:testnet";
const log = (who: string, s: string) => console.log(`[${who.padEnd(7)}] ${s}`);

export class LlmAgent {
  persona: Persona;
  address!: string;
  chain!: Chain;
  agent!: Agent;
  pay!: typeof fetch;
  earned = 0n;
  spent = 0n;
  /** What this agent is working on. It travels with every request, because the
   *  others see nothing except what it sends them. */
  private work: string;
  private stop = false;

  constructor(persona: Persona) {
    this.persona = persona;
    this.work = persona.start;
  }

  async start(deposit: bigint) {
    const { kp, chain, agent } = await setup(this.persona.id, deposit);
    this.address = kp.publicKey();
    this.chain = chain;
    this.agent = agent;

    // selling side
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER })).register(
      NETWORK,
      new BatchSettlementStellarServer({ asset: dep.token }),
    );
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /ask": {
            accepts: { scheme: "batch-settlement", network: NETWORK, payTo: this.address, price: this.persona.price },
            description: this.persona.sells,
          },
        },
        rs,
      ),
    );
    app.get("/ask", async (req, res) => {
      const q = String(req.query.q ?? "").slice(0, 400);
      const from = String(req.query.from ?? "someone");
      log(this.persona.name, `paid request from ${from}: "${q.slice(0, 70)}"`);
      const answer = await ask(`${this.persona.role}\n\nRequest: ${q}\n\nAnswer in at most 40 words.`);
      this.earned += BigInt(Math.round(Number(this.persona.price) * 1e7));
      res.json({ from: this.persona.id, answer: answer || "(no answer)" });
    });
    app.listen(this.persona.port);

    // buying side
    const client = new x402Client()
      .register(NETWORK, new BatchSettlementStellarClient(agent))
      .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: dep.token, maxAmountPerPayment: "2000000" }] });
    this.pay = wrapFetchWithPayment(fetch, client);

    log(this.persona.name, `ready on :${this.persona.port}, ${this.address.slice(0, 8)}…, in vault ${fmt(await chain.balanceOf(this.address))}`);
  }

  /** Claude picks who to buy from and what to ask. */
  private async decide() {
    const others = PERSONAS.filter((p) => p.id !== this.persona.id);
    const menu = others.map((p) => `- ${p.id}: sells ${p.sells} (${p.price} per call)`).join("\n");
    const choice = await askJson<{ peer: string; question: string }>(
      `${this.persona.role}\n\n${this.persona.goal}\n\nYour work in progress:\n"${this.work}"\n\n` +
        `You can buy one thing right now:\n${menu}\n\n` +
        `Pick the one that helps you most and write the request. The other agent sees nothing but ` +
        `your request, so put the text it needs inside it. ` +
        `Format: {"peer": "<id>", "question": "<under 40 words, self-contained>"}`,
    );
    if (!choice || !byId(choice.peer) || choice.peer === this.persona.id) return null;
    return choice;
  }

  /** One round: decide, pay, read the answer. */
  async round() {
    const choice = await this.decide();
    if (!choice) return;
    const peer = byId(choice.peer)!;
    const url = `http://localhost:${peer.port}/ask?from=${this.persona.id}&q=${encodeURIComponent(choice.question)}`;
    log(this.persona.name, `buying from ${peer.id} (${peer.price}): "${choice.question.slice(0, 70)}"`);
    try {
      const res = await this.pay(url);
      if (res.status !== 200) {
        const sr = res.headers.get("payment-response");
        const reason = sr ? JSON.parse(Buffer.from(sr, "base64").toString()).errorReason : `http_${res.status}`;
        log(this.persona.name, `REFUSED by the ledger: ${reason}`);
        return;
      }
      const body = (await res.json()) as { answer: string };
      this.spent += BigInt(Math.round(Number(peer.price) * 1e7));
      const answer = body.answer.replace(/\s+/g, " ");
      this.work = `${this.work} | ${peer.id} said: ${answer}`.slice(-700);
      log(this.persona.name, `got: "${answer.slice(0, 90)}"`);
    } catch (e) {
      log(this.persona.name, `payment failed: ${(e as Error).message.slice(0, 90)}`);
    }
  }

  /** Buy something every `everyMs` (plus jitter) until stopped. */
  loop(everyMs: number) {
    const tick = async () => {
      if (this.stop) return;
      await this.round();
      setTimeout(tick, everyMs + Math.random() * everyMs * 0.5);
    };
    setTimeout(tick, Math.random() * everyMs);
  }

  halt() {
    this.stop = true;
  }
}
