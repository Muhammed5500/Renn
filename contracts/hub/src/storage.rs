use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::errors::Error;
use crate::types::Config;

/// RULE: no data critical for settlement is written to temporary storage.
/// Temporary data does not come back once it is evicted.
///
/// v3.3: receipt, epoch index, maturity and pending scope keys were REMOVED.
#[contracttype]
pub enum DataKey {
    /// instance
    Config,
    /// persistent: raw ed25519 public key
    Signer(Address),
    /// persistent: internal balance
    Balance(Address),
    /// persistent: (payer, recipient) cumulative
    Paid(Address, Address),
    /// persistent: exit_start ledger
    ExitAt(Address),
    /// persistent: counter of operator-approved withdrawals
    WithdrawNonce(Address),
}

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const BUMP_THRESHOLD: u32 = 25 * DAY_IN_LEDGERS;

fn bump(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(e: &Env, k: &DataKey) -> Option<V> {
    e.storage().persistent().get(k)
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(e: &Env, k: DataKey, v: &V) {
    e.storage().persistent().set(&k, v);
    bump(e, &k);
}

// ---------- config ----------

pub fn get_config(e: &Env) -> Result<Config, Error> {
    e.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

pub fn set_config(e: &Env, cfg: &Config) {
    e.storage().instance().set(&DataKey::Config, cfg);
    e.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

// ---------- signer ----------

pub fn get_signer(e: &Env, who: &Address) -> Option<BytesN<32>> {
    get(e, &DataKey::Signer(who.clone()))
}

pub fn set_signer(e: &Env, who: &Address, key: &BytesN<32>) {
    put(e, DataKey::Signer(who.clone()), key);
}

// ---------- balance ----------

pub fn get_balance(e: &Env, who: &Address) -> i128 {
    get(e, &DataKey::Balance(who.clone())).unwrap_or(0)
}

pub fn set_balance(e: &Env, who: &Address, amount: i128) {
    put(e, DataKey::Balance(who.clone()), &amount);
}

// ---------- per-pair cumulative ----------

pub fn get_paid(e: &Env, payer: &Address, recipient: &Address) -> i128 {
    get(e, &DataKey::Paid(payer.clone(), recipient.clone())).unwrap_or(0)
}

pub fn set_paid(e: &Env, payer: &Address, recipient: &Address, amount: i128) {
    put(e, DataKey::Paid(payer.clone(), recipient.clone()), &amount);
}

// ---------- exit ----------

pub fn get_exit_at(e: &Env, who: &Address) -> Option<u32> {
    get(e, &DataKey::ExitAt(who.clone()))
}

pub fn set_exit_at(e: &Env, who: &Address, at: u32) {
    put(e, DataKey::ExitAt(who.clone()), &at);
}

// ---------- withdrawal approval counter ----------

pub fn get_withdraw_nonce(e: &Env, who: &Address) -> u64 {
    get(e, &DataKey::WithdrawNonce(who.clone())).unwrap_or(0)
}

pub fn set_withdraw_nonce(e: &Env, who: &Address, n: u64) {
    put(e, DataKey::WithdrawNonce(who.clone()), &n);
}

/// Permissionless TTL extension. Touches a participant's persistent keys.
/// Per-pair `Paid` keys are already extended on every settlement.
pub fn touch(e: &Env, who: &Address) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
    for k in [
        DataKey::Signer(who.clone()),
        DataKey::Balance(who.clone()),
        DataKey::ExitAt(who.clone()),
        DataKey::WithdrawNonce(who.clone()),
    ] {
        if e.storage().persistent().has(&k) {
            bump(e, &k);
        }
    }
}
