use soroban_sdk::contracterror;

/// Error codes. Numbers are taken exactly from PLAN-golge-defter.md section 4.
///
/// Codes marked DEAD are left over from earlier architectures. Do NOT shift
/// the numbers, leave them in place - everything outside (ledger, SDK, demo)
/// depends on these numbers.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// exit_delay == 0
    BadConfig = 1,
    // NotFunder = 2,            DEAD (v1)
    // NotArbiter = 3,           DEAD (v1)
    // NotRecipient = 4,         DEAD (v2)
    /// delta <= 0 (settle_one). Not an error in settle_batch, the voucher is skipped.
    StaleVoucher = 5,
    /// the payer's balance does not cover the delta (settle_one)
    InsufficientBalance = 6,
    EmptyBatch = 7,
    // DuplicateRecipient = 8,   DEAD (v2)
    // NoReceipt = 9,            DEAD (v3.3: no receipts)
    // WindowPassed = 10,        DEAD (v3.3: no disputes)
    // AlreadyDisputed = 11,     DEAD (v3.3: no disputes)
    // AlreadyResolved = 12,     DEAD (v2)
    // NotClosing = 13,          DEAD (v2)
    // TooEarly = 14,            DEAD (v2)
    // OpenDispute = 15,         DEAD (v3.2)
    NotInitialized = 16,
    // MixedEpoch = 17,          DEAD (v3.3: no epochs)
    // ReceiptExists = 18,       DEAD (v3.3: no receipts)
    /// escape hatch: exit_delay has not passed yet
    NotWithdrawable = 19,
    // NoScope = 20,             DEAD (v3.3.1: scope removed)
    // NoViolation = 21,         DEAD (v3.3: no disputes)
    // BadOpening = 22,          privacy, not present
    EmptyBalance = 23,
    /// payer is not registered
    NotJoined = 24,
    AlreadyJoined = 25,
    /// a registered participant tried to withdraw without the operator
    /// before calling exit_start
    NotExiting = 26,
    SelfPayment = 27,
    /// the same (payer, recipient) twice in one batch
    DuplicatePair = 28,
    // BadEpoch = 29,            DEAD (v3.3: no epochs)
    // InsufficientBond = 30,    DEAD (v3.3: no bond)
    /// a registered participant cannot be pushed with payout
    NotPushable = 31,
    // OverCommitted = 32,       DEAD (v3.3: solvency lives in the ledger)
    // OverRecipientCap = 33,    DEAD (v3.3: scope lives in the ledger)
    // Exiting = 34,             DEAD (v3.3.1: scope removed)
    /// v3.3: amount <= 0 or overflow
    BadAmount = 35,
    /// v3.3: the withdrawal approval's validity (valid_until) has passed
    ApprovalExpired = 36,
    /// v3.3: the approved withdrawal amount is larger than the balance
    ExceedsBalance = 37,
}
