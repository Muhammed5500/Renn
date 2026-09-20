# Four Claude agents on Renn

Four agents that sell one thing each and buy from the others, paying per call over x402 through the Renn ledger. Both halves of every round are Claude: the agent decides what to buy and from whom, and the seller writes the answer.

| Agent | Port | Price | Sells |
|---|---|---|---|
| Scout | 8801 | 0.05 | short factual briefs |
| Analyst | 8802 | 0.08 | trade-offs and a recommendation |
| Writer | 8803 | 0.12 | tight copy |
| Critic | 8804 | 0.10 | the weakest point and the fix |

## Run

```bash
cd ../..                     && AUTO_SETTLE=1 ROUND_MS=60000 npm start   # the ledger
cd examples/llm-agents       && npm install && node run.ts                # the agents
# watch: http://localhost:8787
```

`ROUND_MS` sets how often each agent buys (default 30 s), `DEPOSIT` the first deposit in tokens (default 20).

## How it works

- The LLM is the local `claude` CLI in print mode, so there is no API key; it runs from an empty temp directory so it answers the prompt instead of reading this repo. Each round costs two Claude calls, one to decide and one to answer.
- Identities live in `state/<agent>.json`: the Stellar secret and the voucher seed. Restarting keeps the same addresses and the same vault balances.
- The first run funds each agent through friendbot, mints test tokens with the `deployer` identity, joins the vault and deposits. After that it only tops up when an agent is nearly empty.
- Each agent carries its work in progress into the request it sends, because the others see nothing else.
- Payments are ordinary x402: the seller answers 402, the buyer signs a voucher, the ledger accepts it, and the answer comes back on the same request. Settlement happens later, in batches.

This folder is outside the Renn repository on purpose: it is a local playground, and `state/` holds private keys.
