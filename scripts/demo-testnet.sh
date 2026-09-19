#!/usr/bin/env bash
# Testnet uctan uca deneme, v3.3. ADIM R6 kabul kriteri:
#   - iki imzali (odeyen + operator) bir fis zincirde uzlasiyor
#   - operator onayli cekim gercek token tasiyor, exit_start ve bekleme yok
#
# Yukler kontrattan okunur, imzalar Node'un crypto'su ile atilir. Zincir disi
# yuk uretimi defterin isi (ADIM D1).
set -euo pipefail
cd "$(dirname "$0")/.."

HUB=$(python -c "import json;print(json.load(open('deployments.json'))['hub'])")
TOKEN=$(python -c "import json;print(json.load(open('deployments.json'))['token'])")
NET=testnet
OP_SEED=$(grep '^OPERATOR_SEED=' .env | cut -d= -f2)
U=10000000   # 1 birim = 10^7 (7 ondalik)

# Taze hesaplar: her calistirmada ayni rakamlar.
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
birim() { python -c "print(f'{int($1)/10000000:.2f}')"; }

say "0. Kurulum"
echo "hub   $HUB"
echo "p     $P  (kayitli odeyen)"
echo "r     $R  (kayitsiz alici, hicbir sey kurmuyor)"

say "1. p kaydoluyor ve 20 birim yatiriyor"
PUB=$(node scripts/sign.js pubkey "$SEED_P")
hub --source "$NP" -- join --who "$NP" --commitment_key "$PUB" >/dev/null 2>&1
stellar contract invoke --id "$TOKEN" --network "$NET" --source deployer -- \
  mint --to "$P" --amount $((20 * U)) >/dev/null 2>&1
hub --source "$NP" -- deposit --who "$NP" --amount $((20 * U)) >/dev/null 2>&1
echo "p kasada: $(birim "$(rd -- balance_of --who "$P")")"

say "2. Fis: p, r'ye 7 birim (ZINCIRE GITMEZ)"
CUM=$((7 * U))
VH=$(rd -- voucher_hash --payer "$P" --recipient "$R" --cumulative "$CUM")
SIG=$(node scripts/sign.js sign "$SEED_P" "$VH")
echo "odeyen imzasi:   ${SIG:0:24}..."

say "3. Golge defter kabul ediyor (operator imzasi)"
AH=$(rd -- accept_hash --payer "$P" --recipient "$R" --cumulative "$CUM")
OPSIG=$(node scripts/sign.js sign "$OP_SEED" "$AH")
echo "operator imzasi: ${OPSIG:0:24}..."

say "4. Defteri atlama denemesi: operator imzasi olmadan"
ZERO=$(printf '0%.0s' $(seq 1 128))
if hub --source keeper -- settle_one --caller keeper \
  --v "{\"payer\":\"$P\",\"recipient\":\"$R\",\"cumulative\":\"$CUM\",\"sig\":\"$SIG\",\"op_sig\":\"$ZERO\"}" >/dev/null 2>&1; then
  echo "HATA: operatorsuz fis gecti"; exit 1
else
  echo "reddedildi (dogru)"
fi

say "5. Uzlasma (izinsiz, keeper tetikliyor)"
HUB_BEFORE=$(tokbal "$HUB")
hub --source keeper -- settle_one --caller keeper \
  --v "{\"payer\":\"$P\",\"recipient\":\"$R\",\"cumulative\":\"$CUM\",\"sig\":\"$SIG\",\"op_sig\":\"$OPSIG\"}" 2>&1 | tail -1
HUB_AFTER=$(tokbal "$HUB")
echo "kasa token bakiyesi: $(birim "$HUB_BEFORE") -> $(birim "$HUB_AFTER")  (degismemeli)"
echo "p kasada: $(birim "$(rd -- balance_of --who "$P")")"
echo "r kasada: $(birim "$(rd -- balance_of --who "$R")")"
[ "$HUB_BEFORE" = "$HUB_AFTER" ] || { echo "HATA: token hareket etti"; exit 1; }

say "6. p, 5 birim cekmek istiyor: operator onayi, ANINDA"
NONCE=$(rd -- withdraw_nonce_of --who "$P")
SEQ=$(curl -s -X POST https://soroban-testnet.stellar.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | python -c "import json,sys;print(json.load(sys.stdin)['result']['sequence'])")
UNTIL=$((SEQ + 60))
WH=$(rd -- withdraw_hash --who "$P" --amount $((5 * U)) --nonce "$NONCE" --valid_until "$UNTIL")
WSIG=$(node scripts/sign.js sign "$OP_SEED" "$WH")
hub --source "$NP" -- withdraw_approved --who "$NP" --amount $((5 * U)) \
  --valid_until "$UNTIL" --op_sig "$WSIG" 2>&1 | tail -1
echo "p cuzdanda: $(birim "$(tokbal "$P")")   (5 olmali)"
echo "p kasada:   $(birim "$(rd -- balance_of --who "$P")")   (8 olmali)"

say "7. r (kayitsiz) istedigi an cekiyor"
hub --source "$NR" -- withdraw --who "$NR" 2>&1 | tail -1
echo "r cuzdanda: $(birim "$(tokbal "$R")")   (7 olmali)"

say "BITTI"
echo "https://stellar.expert/explorer/testnet/contract/$HUB"
