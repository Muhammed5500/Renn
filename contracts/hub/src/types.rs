use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Setup configuration. Lives in instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// SEP-41 token. It is an INTERFACE - the code makes no assumption about this address.
    /// Adding the SPP entry later depends on this (plan section 11, item 1).
    pub token: Address,
    /// Raw ed25519 public key of the ledger (the operator). The contract
    /// rejects any voucher without this key's acceptance signature, so the
    /// ledger cannot be bypassed.
    pub operator: BytesN<32>,
    /// Wait for a registered participant's withdrawal without the operator
    /// (ESCAPE HATCH), in ledgers. Gives the operator or the recipients time
    /// to settle pending vouchers.
    pub exit_delay: u32,
}

// NOTE: signed payloads are TUPLES, not STRUCTS. Their definitions and the
// reasoning are at the top of voucher.rs.

/// A voucher coming from off chain. Carries TWO SIGNATURES.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Voucher {
    pub payer: Address,
    pub recipient: Address,
    /// Total so far for this PAIR. Each new voucher replaces the previous
    /// one. This counter prevents reuse.
    pub cumulative: i128,
    /// With the payer's registered commitment_key, over the "batchv3" payload.
    pub sig: BytesN<64>,
    /// The operator's acceptance signature, over the "acceptv1" payload.
    pub op_sig: BytesN<64>,
}

/// Result of settle_batch.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleOutcome {
    /// Total delta applied.
    pub total: i128,
    /// Number of vouchers applied.
    pub settled: u32,
    /// v3.3: number of vouchers SKIPPED because they are stale or already
    /// settled. The batch does not fail because of them.
    pub stale: u32,
    /// Payers whose payments were left unbacked. Stays EMPTY as long as the
    /// ledger builds prefix batches; a non-empty list means a ledger bug.
    pub skipped: Vec<Address>,
}
