# Deliberate ambiguities — decisions, implementation, reasoning

## #1 (required) · A withdrawal we declared failed after silence turns out to have succeeded

> We declared a withdrawal failed after a while without an answer. The user then withdrew the same money again.
> Now the payout service says the first withdrawal succeeded too. What do you do, and which earlier decision
> should have been made differently?

### The decision that should have been different

**Treating silence as failure.** A timeout tells you nothing about the outcome. The probe showed it plainly
(`provider-notes.md` PO-3). A `503` or a dropped connection can mean the transfer was created *and paid*, and for
90 s afterwards `GET` even answers `404`. Releasing the hold on silence is what made the second withdrawal
possible. These are the things done differently in this service:

| Earlier decision | What this service does |
|---|---|
| Timeout or no answer → `FAILED`, hold released | Unknown outcome → stays `PROCESSING`, **funds stay held**. Only a *definitive* answer releases them: the provider's `FAILED`/`RETURNED`, a 4xx validation error at submit (proof the transfer wasn't created), or a user cancel before submission. |
| A retry generates a new request | `requestId` = the withdrawal id, forever. The provider de-duplicates on it, so a retry can never be a second payout. |
| 404 on GET = "not created" | Before acknowledgement we re-POST the same `requestId` (idempotent). After acknowledgement a 404 means "wait", never "re-create". |
| No escalation | After 30 min without an answer: `needs_review = true`, a `withdrawal.needs_review` event, and the case shows up in `GET /internal/withdrawals/review`. Ops resolves it with evidence from the provider or bank. Code never resolves it on its own. |

The cost: in a provider outage, user funds can stay held for a long time. That is the right side of the
trade-off. A held balance is a support ticket; a double payout is a loss. The review queue and clear statuses
(`PROCESSING` = "with the bank") keep the support load manageable.

### What we do now that it has happened (implemented)

Even with the rules above, the situation can still come from the outside (a provider that reports FAILED and
later SUCCEEDED, a mistaken manual decision, a bank correcting itself). The provider's **signed** `SUCCEEDED` is
treated as the truth, and the ledger must say what really happened. In
`WithdrawalProcessor.lateSuccess` (state-machine transition `LATE_SUCCESS`):

1. **Book the truth, never a negative balance.** We post a `WITHDRAWAL_LATE_SUCCESS` journal: Cr
   `PAYOUT_CLEARING` (+ fee revenue). On the debit side, we take the user's `AVAILABLE` balance as far as it
   goes, and put the rest on a **`RECEIVABLE`** account (the user's debt to the exchange). `available` never goes
   below 0 (the CHECK constraint also guarantees it), and the shortfall is visible as `debt` in
   `GET /wallets/{userId}`.
2. **Mark it.** The withdrawal becomes `SUCCEEDED` with `anomaly = LATE_SUCCESS_AFTER_FAILURE …` and
   `needs_review = true`. Its amount counts against the daily cap of its original day again (forced, because
   reality has already happened).
3. **Contain it.** While the user owes anything, in **any** currency, new withdrawals and outgoing transfers in
   every currency are rejected with `422 ACCOUNT_RESTRICTED` (so the debt can't be dodged by moving USDT out).
   Deposits are still accepted.
4. **Tell the humans.** A `withdrawal.late_success` event goes through the outbox (risk, support,
   notification) with the recovered and outstanding amounts, and an error log is written.
5. **Ops playbook (outside the code):** try to recall the *second* transfer if the bank cycle allows it (Paya can
   be cancelled before settlement). Contact the user. Collect the debt from the next deposits (future work: an
   ops endpoint that settles `RECEIVABLE` from `AVAILABLE`). Escalate to collections if needed. Fix the root
   cause with the provider.

Tested end to end in `test/integration/withdrawals.int-spec.ts › late success after failure`: 1,000,000 is
released, the user withdraws 800,000 again, then the first withdrawal "succeeds". The result is
`available = 0`, `debt = 800,000`, the withdrawal is `SUCCEEDED` with review, further withdrawals get
`ACCOUNT_RESTRICTED`, and the ledger stays balanced.

## #2 (bonus) · The daily cap for USDT, failed withdrawals, and when the day starts

**Which rate turns USDT into Toman?** The 200M-Toman cap is a single per-user risk/AML limit across currencies,
so USDT withdrawals count at their Toman value **at the moment of the request**. Here the rate is a configured
reference rate (`USDT_IRT_RATE`, read in one place, `limitAmountInToman`). In production it would be the
exchange's own USDT/IRT price, taking the *higher* side of the book (a conservative valuation, because the cap
protects the exchange). The product is **rounded up**, so rounding can never help anyone get past the cap. The
rate and the counted amount are **stored on the withdrawal** (`usdt_irt_rate`, `limit_amount_irt`). Releasing
the cap later uses the exact same number, even if the rate has moved. The 1 USDT fee isn't counted: the cap is
about money leaving to a destination.
*Rejected:* a separate USDT cap (that's not the "200M Toman" rule); revaluing at settlement time (the cap could
be exceeded after the fact, and the result isn't deterministic).

**Does a failed withdrawal count?** **No.** The cap limits money that leaves, and a failed, cancelled or returned
withdrawal didn't leave (or came back). Its usage is released on the day it was booked. A late success puts it
back. Concurrency stays safe because both directions are single-row atomic updates. *Risk accepted:* someone
could probe the cap with withdrawals that fail. Failures are provider-side and rare, and a separate velocity
limit on attempts would be the right tool.

**When does the day start?** At **00:00 Asia/Tehran** (UTC+03:30; Iran has had no DST since 2022). The PSP's
settlement report buckets by the Tehran day too (`provider-notes.md` S-1), which keeps operations consistent.
The day comes from the **database clock**, so every instance agrees. A withdrawal counts on the day it was
requested, even if it settles after midnight.

## #3 (bonus) · When may a user cancel a registered withdrawal?

**Only while it is `PENDING`**, i.e. before we have *ever* tried to send it to the payout provider:
`POST /withdrawals/{id}/cancel` (with an Idempotency-Key). The hold and the cap usage are released, and the final
status is `FAILED / CANCELLED_BY_USER`.

From `PROCESSING` on, cancellation is refused with `409 WITHDRAWAL_NOT_CANCELLABLE`. The `PROCESSING` state is
committed *before* the first HTTP call, and after that the transfer may already exist at the provider (PO-3).
The provider has no cancel API. A local "cancel" would release money that may be on its way to the bank,
which is ambiguity #1 again.

Cancel and the dispatcher both take the withdrawal's row lock, so exactly one of them wins. Tests cover the
PENDING cancel (funds and cap released, nothing sent), the refused PROCESSING cancel, the owner check and the
idempotent replay. Because a withdrawal is normally dispatched right away, the cancel window is short. A
configurable cooling-off period (`WITHDRAWAL_DISPATCH_DELAY_MS`, default 0) lengthens it without any code
change. With a provider that supported cancellation, we would also allow a *cancel request* in
`ACCEPTED`/`PROCESSING`. It would become final only when the provider confirms.
