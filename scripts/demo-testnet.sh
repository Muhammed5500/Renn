#!/usr/bin/env bash
# Testnet end-to-end check, v3.3. STEP R6 acceptance criteria:
#   - a voucher with two signatures (payer + operator) settles on chain
#   - an operator-approved withdrawal moves real tokens, no exit_start, no wait
#
# Payloads are read from the contract, signatures are made with Node's crypto.
# Producing payloads off chain is the ledger's job (STEP D1).
set -euo pipefail
cd "$(dirname "$0")/.."

HUB=$(python -c "import json;print(json.load(open('deployments.json'))['hub'])")
TOKEN=$(python -c "import json;print(json.load(open('deployments.json'))['token'])")
NET=testnet
OP_SEED=$(grep '^OPERATOR_SEED=' .env | cut -d= -f2)
U=10000000   # 1 unit = 10^7 (7 decimals)

# Fresh accounts: the same numbers on every run.
RUN=$(date +%s)
NP="p_$RUN"; NR="r_$RUN"
stellar keys generate "$NP" --network testnet --fund >/dev/null 2>&1
stellar keys generate "$NR" --network testnet --fund >/dev/null 2>&1
P=$(stellar keys address "$NP")
R=$(stellar keys address "$NR")
SEED_P=$(python -c "import hashlib;print(hashlib.sha256(b'p$RUN').hexdigest())")

say() { echo; echo "=== $* ==="; }
hub() { stellar contract invoke --id "$HUB" --network "$NET" "$@"; }
rd() { stellar contract invoke --id "$HUB" --network "$NET" --source keeper --send=no "$@" 2>/dev/null | tail -1 | tr -d '"'; }
tokbal() { stellar contract invoke --id "$TOKEN" --network "$NET" --source keeper --send=no -- balance --id "$1" 2>/dev/null | tail -1 | tr -d '"'; }
units() { python -c "print(f'{int($1)/10000000:.2f}')"; }

say "0. Setup"
echo "hub   $HUB"
echo "p     $P  (registered payer)"
echo "r     $R  (unregistered recipient, sets nothing up)"

say "1. p registers and deposits 20 units"
PUB=$(node scripts/sign.js pubkey "$SEED_P")
hub --source "$NP" -- join --who "$NP" --commitment_key "$PUB" >/dev/null 2>&1
stellar contract invoke --id "$TOKEN" --network "$NET" --source deployer -- \
  mint --to "$P" --amount $((20 * U)) >/dev/null 2>&1
hub --source "$NP" -- deposit --who "$NP" --amount $((20 * U)) >/dev/null 2>&1
echo "p in vault: $(units "$(rd -- balance_of --who "$P")")"

say "2. Voucher: p pays r 7 units (DOES NOT GO ON CHAIN)"
CUM=$((7 * U))
VH=$(rd -- voucher_hash --payer "$P" --recipient "$R" --cumulative "$CUM")
SIG=$(node scripts/sign.js sign "$SEED_P" "$VH")
echo "payer signature:    ${SIG:0:24}..."

say "3. The shadow ledger accepts it (operator signature)"
AH=$(rd -- accept_hash --payer "$P" --recipient "$R" --cumulative "$CUM")
OPSIG=$(node scripts/sign.js sign "$OP_SEED" "$AH")
echo "operator signature: ${OPSIG:0:24}..."

say "4. Attempt to bypass the ledger: no operator signature"
ZERO=$(printf '0%.0s' $(seq 1 128))
if hub --source keeper -- settle_one --caller keeper \
  --v "{\"payer\":\"$P\",\"recipient\":\"$R\",\"cumulative\":\"$CUM\",\"sig\":\"$SIG\",\"op_sig\":\"$ZERO\"}" >/dev/null 2>&1; then
  echo "ERROR: voucher without operator signature passed"; exit 1
else
  echo "rejected (correct)"
fi

say "5. Settlement (permissionless, triggered by keeper)"
HUB_BEFORE=$(tokbal "$HUB")
hub --source keeper -- settle_one --caller keeper \
  --v "{\"payer\":\"$P\",\"recipient\":\"$R\",\"cumulative\":\"$CUM\",\"sig\":\"$SIG\",\"op_sig\":\"$OPSIG\"}" 2>&1 | tail -1
HUB_AFTER=$(tokbal "$HUB")
echo "vault token balance: $(units "$HUB_BEFORE") -> $(units "$HUB_AFTER")  (must not change)"
echo "p in vault: $(units "$(rd -- balance_of --who "$P")")"
echo "r in vault: $(units "$(rd -- balance_of --who "$R")")"
[ "$HUB_BEFORE" = "$HUB_AFTER" ] || { echo "ERROR: tokens moved"; exit 1; }

say "6. p wants to withdraw 5 units: operator approval, INSTANT"
NONCE=$(rd -- withdraw_nonce_of --who "$P")
SEQ=$(curl -s -X POST https://soroban-testnet.stellar.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | python -c "import json,sys;print(json.load(sys.stdin)['result']['sequence'])")
UNTIL=$((SEQ + 60))
WH=$(rd -- withdraw_hash --who "$P" --amount $((5 * U)) --nonce "$NONCE" --valid_until "$UNTIL")
WSIG=$(node scripts/sign.js sign "$OP_SEED" "$WH")
hub --source "$NP" -- withdraw_approved --who "$NP" --amount $((5 * U)) \
  --valid_until "$UNTIL" --op_sig "$WSIG" 2>&1 | tail -1
echo "p in wallet: $(units "$(tokbal "$P")")   (should be 5)"
echo "p in vault:  $(units "$(rd -- balance_of --who "$P")")   (should be 8)"

say "7. r (unregistered) withdraws whenever it wants"
hub --source "$NR" -- withdraw --who "$NR" 2>&1 | tail -1
echo "r in wallet: $(units "$(tokbal "$R")")   (should be 7)"

say "DONE"
echo "https://stellar.expert/explorer/testnet/contract/$HUB"
