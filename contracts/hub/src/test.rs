#![cfg(test)]
//! Shared setup + registration, deposit and TTL tests.

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Env, String,
};

// ---------- shared setup ----------

/// Demo setting: ~5 min. Suggested for production: 17280 (~1 day).
pub const EXIT_DELAY: u32 = 60;

/// Raw ed25519 key. Both the agent's hot key and the operator's key are this.
pub struct Key(pub SigningKey);

impl Key {
    pub fn new(seed: u8) -> Key {
        Key(SigningKey::from_bytes(&[seed; 32]))
    }

    pub fn pubkey(&self, e: &Env) -> BytesN<32> {
        BytesN::from_array(e, &self.0.verifying_key().to_bytes())
    }

    pub fn sign_hash(&self, e: &Env, h: &BytesN<32>) -> BytesN<64> {
        BytesN::from_array(e, &self.0.sign(&h.to_array()).to_bytes())
    }
}

pub struct Fix<'a> {
    pub e: Env,
    pub hub: HubClient<'a>,
    pub token: testtoken::TestTokenClient<'a>,
    pub hub_addr: Address,
    pub token_addr: Address,
    /// The shadow ledger's key.
    pub op: Key,
}

pub const OP_SEED: u8 = 200;

pub fn setup() -> Fix<'static> {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_sequence_number(1000);

    let admin = Address::generate(&e);
    let token_addr = e.register(
        testtoken::TestToken,
        (
            admin,
            String::from_str(&e, "Test USD"),
            String::from_str(&e, "TUSD"),
        ),
    );
    let token = testtoken::TestTokenClient::new(&e, &token_addr);

    let op = Key::new(OP_SEED);
    let hub_addr = e.register(Hub, (token_addr.clone(), op.pubkey(&e), EXIT_DELAY));
    let hub = HubClient::new(&e, &hub_addr);

    Fix {
        e,
        hub,
        token,
        hub_addr,
        token_addr,
        op,
    }
}

impl Fix<'_> {
    /// Creates a funded address (in the wallet, not in the vault).
    pub fn funded(&self, amount: i128) -> Address {
        let a = Address::generate(&self.e);
        if amount > 0 {
            self.token.mint(&a, &amount);
        }
        a
    }

    pub fn advance(&self, ledgers: u32) {
        let s = self.e.ledger().sequence();
        self.e.ledger().set_sequence_number(s + ledgers);
    }

    /// Registered participant: funded + joined + deposited into the vault.
    pub fn payer(&self, seed: u8, deposit: i128) -> (Address, Key) {
        let k = Key::new(seed);
        let a = self.funded(deposit);
        self.hub.join(&a, &k.pubkey(&self.e));
        if deposit > 0 {
            self.hub.deposit(&a, &deposit);
        }
        (a, k)
    }

    /// Valid voucher with two signatures: the payer signs, the operator accepts.
    /// Payloads are read from the contract, so both sides use the same bytes.
    pub fn voucher(&self, payer: &Address, key: &Key, recipient: &Address, cumulative: i128) -> Voucher {
        self.voucher_by(payer, key, recipient, cumulative, &self.op)
    }

    /// Voucher accepted with the given key (for fake operator tests).
    pub fn voucher_by(
        &self,
        payer: &Address,
        key: &Key,
        recipient: &Address,
        cumulative: i128,
        op: &Key,
    ) -> Voucher {
        let h = self.hub.voucher_hash(payer, recipient, &cumulative);
        let a = self.hub.accept_hash(payer, recipient, &cumulative);
        Voucher {
            payer: payer.clone(),
            recipient: recipient.clone(),
            cumulative,
            sig: key.sign_hash(&self.e, &h),
            op_sig: op.sign_hash(&self.e, &a),
        }
    }

    /// The operator's withdrawal approval. The nonce is read from the contract.
    pub fn approval(&self, who: &Address, amount: i128, valid_until: u32) -> BytesN<64> {
        let nonce = self.hub.withdraw_nonce_of(who);
        let h = self.hub.withdraw_hash(who, &amount, &nonce, &valid_until);
        self.op.sign_hash(&self.e, &h)
    }

    /// Unlimited budget (for large batch tests).
    pub fn unlimited(&self) {
        self.e.cost_estimate().budget().reset_unlimited();
    }
}

// ================= setup =================

#[test]
fn test_constructor_stores_config() {
    let f = setup();
    let c = f.hub.config();
    assert_eq!(c.token, f.token_addr);
    assert_eq!(c.operator, f.op.pubkey(&f.e));
    assert_eq!(c.exit_delay, EXIT_DELAY);
}

#[test]
#[should_panic]
fn test_constructor_rejects_zero_exit_delay() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let token_addr = e.register(
        testtoken::TestToken,
        (admin, String::from_str(&e, "T"), String::from_str(&e, "T")),
    );
    e.register(Hub, (token_addr, Key::new(1).pubkey(&e), 0u32));
}

// ================= registration =================

#[test]
fn test_join_stores_signer() {
    let f = setup();
    let p = f.funded(0);
    let key = BytesN::from_array(&f.e, &[7u8; 32]);
    f.hub.join(&p, &key);
    assert_eq!(f.hub.signer_of(&p), Some(key));
}

#[test]
fn test_join_twice_fails() {
    let f = setup();
    let p = f.funded(0);
    let key = BytesN::from_array(&f.e, &[7u8; 32]);
    f.hub.join(&p, &key);
    assert_eq!(f.hub.try_join(&p, &key), Err(Ok(Error::AlreadyJoined)));
}

#[test]
fn test_join_requires_auth() {
    let f = setup();
    let p = f.funded(0);
    f.e.set_auths(&[]);
    let key = BytesN::from_array(&f.e, &[7u8; 32]);
    assert!(f.hub.try_join(&p, &key).is_err());
    assert_eq!(f.hub.signer_of(&p), None);
}

// ================= deposit =================

#[test]
fn test_deposit_credits_balance() {
    let f = setup();
    let p = f.funded(1000);
    f.hub.deposit(&p, &400);
    assert_eq!(f.hub.balance_of(&p), 400);
    assert_eq!(f.token.balance(&f.hub_addr), 400, "token moved to the contract");
    assert_eq!(f.token.balance(&p), 600);
}

#[test]
fn test_deposit_needs_no_join() {
    // The vault does not ask where the money comes from. The SPP entry depends on this.
    let f = setup();
    let r = f.funded(100);
    f.hub.deposit(&r, &100);
    assert_eq!(f.hub.balance_of(&r), 100);
    assert_eq!(f.hub.signer_of(&r), None);
}

#[test]
fn test_deposit_accumulates() {
    let f = setup();
    let p = f.funded(1000);
    f.hub.deposit(&p, &100);
    f.hub.deposit(&p, &250);
    assert_eq!(f.hub.balance_of(&p), 350);
}

#[test]
fn test_deposit_rejects_zero() {
    let f = setup();
    let p = f.funded(1000);
    assert_eq!(f.hub.try_deposit(&p, &0), Err(Ok(Error::BadAmount)));
    assert_eq!(f.hub.try_deposit(&p, &-5), Err(Ok(Error::BadAmount)));
}

#[test]
fn test_deposit_requires_auth() {
    let f = setup();
    let p = f.funded(1000);
    f.e.set_auths(&[]);
    assert!(f.hub.try_deposit(&p, &100).is_err());
    assert_eq!(f.token.balance(&p), 1000);
}

#[test]
fn test_unknown_balances_are_zero() {
    let f = setup();
    let a = Address::generate(&f.e);
    let b = Address::generate(&f.e);
    assert_eq!(f.hub.balance_of(&a), 0);
    assert_eq!(f.hub.paid_between(&a, &b), 0);
    assert_eq!(f.hub.signer_of(&a), None);
    assert_eq!(f.hub.withdraw_nonce_of(&a), 0);
}

// ================= TTL =================

#[test]
fn test_ttl_extended_on_write() {
    let f = setup();
    let (p, k) = f.payer(1, 500);
    let r = Address::generate(&f.e);
    f.hub.settle_one(&r, &f.voucher(&p, &k, &r, 100));

    // TTL was extended to 30 days, so it is still readable after 20 days
    f.advance(crate::storage::DAY_IN_LEDGERS * 20);
    assert_eq!(f.hub.balance_of(&r), 100);
    assert_eq!(f.hub.paid_between(&p, &r), 100);
}

#[test]
fn test_extend_ttl_is_permissionless() {
    let f = setup();
    let (p, _k) = f.payer(1, 500);
    f.e.set_auths(&[]);
    f.hub.extend_ttl(&p);
    f.advance(crate::storage::DAY_IN_LEDGERS * 20);
    assert_eq!(f.hub.balance_of(&p), 500);
}
