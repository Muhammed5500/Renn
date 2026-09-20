// Every outward link the landing page uses, in one place.
// Chain addresses come from Proje/deployments.json (v3.3.1, Stellar testnet).

export const REPO = "https://github.com/Muhammed5500/Renn";
export const NPM = "https://www.npmjs.com/package/rennpay";

export const VAULT = "CCQ4EM423WGMSRUGXBAKHZ7IIMDI7JWGLOOMDVTP4IATQHFB74ZUZX47";
export const TOKEN = "CBXCYC6QC2V2CTAE2U44LMYO2WBLIR7MU7K4YI737OKKQZAJJ4LFE2WA";
export const SPP_POOL = "CAVLB3J4I5EPWAFWZ6O464DNPMK523TCNTSECN3XGLUNPGAXTYZ3Q2OW";

export const contract = (id: string) =>
  `https://stellar.expert/explorer/testnet/contract/${id}`;
export const tx = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;

export const docs = {
  readme: `${REPO}#readme`,
  scheme: `${REPO}/blob/main/docs/scheme_batch_settlement_stellar.md`,
  limits: `${REPO}/blob/main/LIMITS.md`,
  notes: `${REPO}/blob/main/NOTES.md`,
  contract: `${REPO}/tree/main/contracts/hub`,
  ledger: `${REPO}/tree/main/operator/src`,
  sdk: `${REPO}/tree/main/sdk`,
  examples: `${REPO}/tree/main/examples/llm-agents`,
  x402: "https://github.com/coinbase/x402",
};

/** Transaction hashes quoted in the README's demo table. */
export const demoTx = {
  circular: "d61993088b75e34baa118a102b95fe952310499d5b5a46ae2986105a7fefb210",
  scale: "41f0fe62e3370e7ba1bc007144b5a478497b82e46bbeefc694ef9bae7d6e3d4d",
  withdraw: "d403dbcc366ec35f1e5169b8aedb30673881b53510764eb473458339b254e5f6",
  settleOne: "bde1f1dadc08c4ff4a5d27204b450b7c4ef577b9efe16f2009b437e048ae4814",
  exitStart: "0d1ee7595d0a267b0764fdc0856113080227dd1092509467a9961cccd2e0d725",
  privateEntry: "de3c7df89ed6928afc1e11a563ce050f33e0913ca281897e89151c8c2784942a",
};
