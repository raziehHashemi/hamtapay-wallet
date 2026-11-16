# Provider notes — what the external services really do

Every behaviour below was **observed** on `hamtapay/t103-simulator:1.0` and changed the design. Each one is
backed by evidence, handled in code, and covered by tests.

**How it was observed.** `scripts/probe-simulator.ts` drives the simulator directly (no wallet service in between)
and listens for callbacks/webhooks itself. Every request, response and inbound call is written to
[`evidence/simulator-probe.log`](evidence/simulator-probe.log) (timestamps are `+seconds` from start). It runs
with `SIM_TIME_SCALE=20`, so all simulator delays below are 20× shorter in the log (that is why 600 s shows up
as 30 s). Experiments `E1`–`E22` are deterministic: each one uses the simulator's own scenario queue
(`POST /__admin/scenario`, enabled with `SIM_ADMIN_KEY`, which I found in the image's `/app/sim.js`) to trigger
one behaviour on demand. Section `H` runs random hostile-mode traffic to measure how often each behaviour happens.
To reproduce:

```bash
docker compose -p hamtapay-probe -f docker-compose.probe.yml up -d
SIM_URL=http://localhost:18080 SIM_ADMIN_KEY=probe-admin-key npm run probe:simulator
```

Tests: **IT** = integration test with a fake that reproduces the behaviour (`test/integration`). **E2E** = the
real simulator in Docker (`test/e2e`).

---

## Payment gateway (PSP)

### PSP-1 · Amounts are in **Rial**, our API is in **Toman**
Evidence (E1): we create a payment of `"1000000"`, and the payment page shows the payer *100,000 Toman*:
```
GET /psp/pay/A07b7a0f1efa93f697 -> 200 {"amount":"1000000","display":"مبلغ قابل پرداخت: ۱۰۰٬۰۰۰ تومان", ...}
```
The settlement file header says `مبلغ (ریال)`, and the payout API only accepts `currency: "IRR"`.
**Design:** every amount that crosses an Iranian rail is multiplied by 10 (`tomanToRial`). The ledger always
stays in Toman. Rial is used only at the boundary. Getting this wrong would make users pay 10× too little.
Tests: unit `money.spec`, IT `deposits › asked for Rial`, E2E `PSP page shows the Toman amount`.

### PSP-2 · Validation: minimum 10,000 Rial, integer only, callbackUrl required
```
POST /psp/payments {"amount":"9999",...}    -> 400 {"code":-12,"message":"amount below minimum"}
POST /psp/payments {"amount":"10000.5",...} -> 400 {"code":-11,"message":"amount must be a positive integer"}
```
**Design:** we check the deposit minimum ourselves (`DEPOSIT_MIN_IRT=1000` Toman = 10,000 Rial) and answer `422
BELOW_MINIMUM` before calling the PSP.

### PSP-3 · `verify` on an unpaid payment says FAILED — but the payer can still pay
Evidence (E3): `verify` right after creation answers like a final failure. The payment is still `INIT`, and it
can be paid and verified a moment later:
```
POST /psp/verify {...} -> 200 {"code":-51,"status":"FAILED","message":"payment not successful"}
GET  /psp/payments/A0d85ea0cf16ddd3b1 -> 200 {"status":"INIT",...}
POST /psp/pay/A0d85ea0cf16ddd3b1 {"result":"success"} -> 200 {"status":"PAID"}
POST /psp/verify {...} -> 200 {"code":100,"status":"OK","amount":"1000000","refId":"8732593111"}
```
**Design:** we **never call verify before the inquiry (`GET /psp/payments/{token}`) says `PAID`/`VERIFIED`**.
If we trusted the `-51`, we would mark the deposit FAILED and then lose a payment that arrives a minute later.
That breaks the rule "a paid deposit must always be credited". Tests: unit `deposit-policy`, IT `a callback
before the payer paid changes nothing`.

### PSP-4 · Callbacks are hints, not facts
The callback body is `{token, orderId, status}`. `status` is `OK`/`NOK` (this isn't documented). The callback
is **unsigned** and never retried. Observed (E5–E8, and section H in hostile mode):

| Behaviour | Evidence | Hostile frequency (H, 40 payments) |
|---|---|---|
| Duplicates: 2–4 copies of the same callback | E5: 4 callbacks for one token | 27 / 40 |
| `NOK` first, `OK` 1.5 s later, for a **paid** payment | E6: `status:"NOK"` then `status:"OK"`, inquiry says `PAID` | 10 / 40 |
| Forged `OK` carrying `amount` **×10** | E7: `{"status":"OK","amount":"10000000"}` for a 1,000,000 payment | 4 / 40 |
| No callback at all | E8: 0 callbacks, inquiry says `PAID` | 6 / 40 |

**Design:** a callback only *triggers* reconciliation. We look up the deposit by token, ask the PSP (inquiry →
verify), and credit the **verified** amount. The callback's `status` and `amount` are never trusted. A poller
(first check after 5 s, backoff up to 30 s) covers missing callbacks. Duplicate callbacks running at the same
time are safe: there's a row lock, a status re-check, and a unique `deposit:<id>:credit` journal reference.
Every callback is stored in `inbound_events` for audit. Tests: IT (10 concurrent duplicates, NOK-then-OK,
forged amount, missing callback), E2E (`orderCb`, `forgeCb`+`dupCb`, `missCb`).

### PSP-5 · `verify` sometimes answers 503 once, and verify is idempotent
```
POST /psp/verify -> 503 {"code":-1,"message":"service unavailable"}
POST /psp/verify -> 200 {"code":100,"status":"OK",...}
POST /psp/verify -> 200 {"code":101,"status":"ALREADY_VERIFIED","amount":"1000000","refId":"3032827833"}
```
**Design:** a 503 keeps the deposit in `VERIFYING`, and it's retried every 3 s. Code `101` counts as success,
so a crash between "PSP verified" and "we credited" heals on the next poll. The business result is in `code`,
not in the HTTP status: failures come back as **HTTP 200** (`-51`, `-54`). Tests: IT `verify answers 503`,
`crash after verify, before credit`, E2E `verify503`.

### PSP-6 · A paid payment that isn't verified within 10 minutes is reversed
Evidence (E10, 600 s ÷ 20 = 30 s): after waiting, inquiry says `REVERSED` and verify answers
```
POST /psp/verify -> 200 {"code":-54,"status":"EXPIRED","message":"payment was not verified in time and has been reversed"}
```
Section H shows it at scale: the probe waits 40 s before verifying, so 38 of the 40 hostile payments came back `-54` (the other 2 hit the one-off 503).
**Design:** the reversal window is the hard deadline for verification. The callback path verifies immediately,
and the poller's worst-case interval (30 s, configurable) stays far below 10 minutes. With `SIM_TIME_SCALE`,
keep `DEPOSIT_POLL_CAP_MS` below 600 s ÷ scale. A reversed payment ends `FAILED/PAYMENT_REVERSED`. The PSP has
refunded the payer, so no money is lost.

### PSP-7 · "Create payment" is not idempotent
Each `POST /psp/payments` creates a new token, even with the same `orderId`. **Design:** we create the payment
inside our idempotent transaction. A retry with the same `Idempotency-Key` replays the stored link, so the PSP
isn't called again. A stray token from a crashed attempt was never shown to anyone, so it can't be paid.

## Payout provider

### PO-1 · Units and formats
IBAN transfers must use `currency:"IRR"` with an integer amount. CRYPTO transfers use `"USDT"` with a decimal
string. `requestId` must be 8–64 characters. (E12: `"IRT"` → `400 INVALID_AMOUNT`, `"100.5"` → `400`,
`"short"` → `400 INVALID_REQUEST_ID`.) **Design:** `toPayoutRequest` converts Toman to Rial. `requestId` = our
withdrawal UUID (36 characters).

### PO-2 · `POST /payout/transfers` is idempotent by `requestId`, even if the body is different
Evidence (E11): the second and third POSTs return `200` with the **same** `trackingId`, even with
`"amount":"999999999"`:
```
POST ... {"requestId":"probe-b74e94eb-…","amount":"1000000",...}   -> 202 {"trackingId":"TRKbc1c76b8785ad7c3","status":"ACCEPTED"}
POST ... {"requestId":"probe-b74e94eb-…","amount":"999999999",...} -> 200 {"trackingId":"TRKbc1c76b8785ad7c3", ...}
```
**Design:** the requestId is **deterministic** (it's the withdrawal id), so every retry is the same transfer.
We never generate a new requestId for an existing withdrawal. Doing that is exactly how a timeout turns into a
double payout.

### PO-3 · 503 and timeouts hide whether the transfer was created — and GET answers 404 for 90 s
| Case | What the caller sees | Was it created? | `GET /payout/transfers/{id}` |
|---|---|---|---|
| E13 `503` before create | `503 {"error":"UPSTREAM_UNAVAILABLE"}` | no | 404 |
| E14 `503` after create | `503 {"error":"UPSTREAM_UNAVAILABLE"}` (same) | **yes**, and it proceeds to SUCCEEDED | **404 for 90 s** |
| E15 timeout | the connection is held for 35 s, then destroyed (`fetch failed`, 1.75 s at scale 20) | **yes** | **404 for 90 s** |

E14 shows the trap: the signed webhooks `PROCESSING` and `SUCCEEDED` arrive while `GET` still answers 404:
```
POST /payout/transfers {...} -> 503 {"error":"UPSTREAM_UNAVAILABLE"}
GET  /payout/transfers/probe-1396d090-… -> 404 {"error":"NOT_FOUND"}
POST /payout/transfers {...same requestId...} -> 200 {"trackingId":"TRKb1eaa902594ffb50","status":"ACCEPTED", ...}
<<< webhook PROCESSING … <<< webhook SUCCEEDED …
GET  /payout/transfers/probe-1396d090-… -> 404 {"error":"NOT_FOUND"}       (3 s later, still hidden)
```
In hostile mode (H, 40 payouts): 6 × `503` and 4 × connection reset.
**Design:**
1. `PROCESSING` is committed **before** the first HTTP call. If the outcome is unknown (5xx, timeout, reset),
   the withdrawal stays `PROCESSING`, the funds stay held, and the call is retried with backoff. Silence never
   becomes `FAILED`. (That is ambiguity #1's lesson; see `ambiguities.md`.)
2. Until the provider has acknowledged the requestId, we **re-POST** (idempotent, see PO-2). Re-POST also
   answers correctly during the hidden window.
3. After acknowledgement we only `GET`. A 404 means "wait", and it's never "re-create". Persistent silence
   flags the withdrawal for review (`needs_review`, after 30 min).
4. Only a 4xx validation error (400/422) is a definitive "not created", so it's the only error that releases
   funds at submit time.

Tests: IT `e503-before / e503-after / timeout: exactly one transfer`, `404 on GET is waited out, never
re-submitted`, `silence is never treated as failure`. E2E: the same three faults against the real simulator,
each checked against the simulator's own record (`executed`, exactly one transfer).

### PO-4 · Destinations are only checked asynchronously
E12: `destination:"IR000000000000000000000000"` is accepted with `202`. It fails ~1 s later with
`FAILED / INVALID_IBAN`. **Design:** we validate up front, so the user's money isn't held for nothing. IBANs are
checked as `IR` + 24 digits with the ISO-13616 mod-97 checksum (spaces, dashes and a missing `IR` prefix are
normalised). TRC20 addresses must be `T` + 33 base58 characters. Bad input gets `400 INVALID_DESTINATION`.

### PO-5 · Webhooks: signed, duplicated, stale, forged, missing, retried
Body: `{event:"transfer.updated", eventId, requestId, trackingId, status, reason, amount, currency, occurredAt}`
with `X-Signature: hex(HMAC-SHA256(raw body, secret))` and `X-Event-Id`.

| Behaviour | Evidence |
|---|---|
| Duplicate delivery, **same** `eventId` | E16: each event delivered twice |
| **Stale** `PROCESSING` after the final state, with a **new** `eventId` and the old `occurredAt` | E16: `evt_a30b…` `PROCESSING occurredAt=…31.100Z` arrives after `SUCCEEDED` |
| **Forged** `FAILED` after `SUCCEEDED`, signature invalid | E17: `status=FAILED sigValid=false`, and `GET` still says `SUCCEEDED` |
| Final webhook missing | E18: only `PROCESSING` arrives, and `GET` says `SUCCEEDED` |
| Retried when we answer non-2xx | E21: the same `eventId` is redelivered after our `500` (backoff 1, 2, 4, 8, 16 s ÷ scale) |

Hostile mode (H): 16 duplicate deliveries, 4 stale, 2 forged, 12 without a signed final webhook (yet).
**Design:** the HMAC is computed over the **raw bytes** with a constant-time compare. A bad signature gets 401
and is audited, never applied. Transitions are **monotonic** (a stale PROCESSING can't undo a final state), so we
don't depend on `eventId` (stale events carry new ids). The poller resolves missing finals. A *signed* FAILED
after SUCCEEDED isn't auto-applied. It's flagged as an anomaly.

### PO-6 · A successful Paya transfer can come back as `RETURNED`
E19: `SUCCEEDED` (10:44:47.390) is followed by `RETURNED / ACCOUNT_CLOSED` (10:44:50.751), i.e. 30–180 s later unscaled. The
settlement file then has a `برگشت پایا` (Paya return) row. Hostile frequency: 4 / 40.
**Design:** a return gives the money back to the user (`WITHDRAWAL_RETURN` journal). The withdrawal ends
`FAILED` with `failureReason: "RETURNED:ACCOUNT_CLOSED"`, and its daily-cap usage is released. If RETURNED is
the first final signal we see, we settle first and then refund, so the ledger matches the bank statement.
Successful IBAN withdrawals keep being polled for a while (`PAYOUT_RETURN_WATCH_MS`, default 1 h) in case the
RETURNED webhook is missed. This change added the migration `AddWithdrawalReturnTracking`.

### PO-7 · Other observed outcomes
`FAILED / BANK_REJECTED` (E20) is a definitive failure, so the funds are released. Slow transfers take 120–600 s
before the final state, so there's no client-side deadline that could fail them. The provider keeps its state
**in memory**: a restarted simulator forgets every transfer (GET 404). Because we never re-create an
acknowledged transfer (PO-3 point 3), that shows up as a review flag, never as a second payout.

## Settlement report (`GET /psp/settlement?date=`)

### S-1 · A real-world messy CSV
Captured file: [`evidence/settlement-sample.csv`](evidence/settlement-sample.csv) (also used as a unit-test
fixture).

| Quirk | Example |
|---|---|
| UTF-8 BOM (`fetch().text()` silently strips it; the raw bytes start `efbbbf`) and CRLF line endings | E22 |
| Persian headers, **Rial** amounts | `ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح` |
| Jalali dates, sometimes in Persian digits | `۱۴۰۵/۰۸/۲۵` and `1405/08/25` in the same file |
| Quoted amounts, `,` or Arabic `٬` (U+066C) as thousands separator, negative debits | `"۱٬۰۰۰٬۰۰۰"`, `"-2,500"` |
| References padded with `000` or spaces | `0006122297631`, ` TRK01a5… ` |
| Exact duplicate lines (same row number) | rows 3, 8, 13, 18, 23 appear twice |
| Bank fee per Paya transfer that isn't in our ledger | `کارمزد` (fee) `-2,500` per withdrawal |
| An unknown deposit every day | `پرداخت اینترنتی نامشخص` (unknown internet payment) with a random ref |
| Only *verified* payments appear; reversed ones don't. The day is the **Asia/Tehran** day | |
| An invalid `date` silently returns today's file | `?date=not-a-date` → 200 |

**Design:** a defensive parser (`settlement-parser.ts`) normalises all of the above. The matcher reports
`MISSING_IN_LEDGER`, `MISSING_IN_SETTLEMENT`, `AMOUNT_MISMATCH`, `DUPLICATE_IN_SETTLEMENT` and
`UNKNOWN_ROW_TYPE`. Fees on our own Paya transfers are summarised as an expected cost, not reported as
mismatches. Records from the neighbouring day (midnight clock skew) aren't reported as missing. We validate the
date ourselves, because the PSP falls back to "today". The "day" in our daily cap is also the Tehran day.
Tests: unit `settlement-parser.spec` (on the captured file), `reconciliation-matcher.spec`, IT and E2E
reconciliation.
