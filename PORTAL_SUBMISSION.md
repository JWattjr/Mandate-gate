# MandateGate: GenLayer Portal submission

## Pitch

**MandateGate is an on-chain authorization gate for treasury liquidity.** A
treasury writes its risk policy once, in plain language. Every proposal to put
funds into the configured pool is then adjudicated by GenLayer validators against
that frozen mandate, using evidence that each validator fetches from the web
itself. A COMPLIANT verdict reserves budget on-chain. Anything else leaves the
budget untouched.

Live app: **https://mandate-gate-azure.vercel.app** · Network: GenLayer **Studio Next** (chain 61997)

> This is an authorization prototype. No assets are held or deployed. Amounts are
> accounting units, and the pool is a synthetic venue.

## Why deterministic contract logic is not enough

A deterministic contract can enforce "≤ 25,000 per proposal" and "≤ 100,000
total". It cannot enforce the policy a real treasury cares about:

> "…only when authoritative evidence establishes that the evidence refers to the configured pool and token identities, the pool is currently active and supported, and no authoritative submitted source reports an active suspension, exploit, deprecation, or material operational warning. Conflicting, ambiguous, non-authoritative, or incomplete evidence is insufficient."

Answering that policy means reading arbitrary web pages. The contract has to
decide:

- whether a page is authoritative
- whether it describes *this* pool or a different one
- whether a notice is an active exploit or a closed incident
- whether the sources conflict

An oracle would reduce all of this to one trusted party's opinion. A multisig
would put the judgment back in human hands.

## Why GenLayer

- **Independent evidence retrieval.** Every validator fetches the submitted URLs
  itself (`gl.nondet.web.get`). The frontend sends only URLs, never content or
  conclusions.
- **Subjective judgment with consensus.** Each validator reads the evidence
  against the frozen mandate with its own LLM. The leader's result is accepted
  only if validators independently reach the **same status**.
- **Consequential state.** The agreed status directly moves the contract's
  budget in the same transaction. No off-chain step or trusted relayer is needed.

## Division of labour

| Deterministic code (no consensus needed) | GenLayer subjective consensus |
| --- | --- |
| Pair and pool identity match configuration | Is a source authoritative for this pool? |
| Positive integer amount, ≤ 25,000 per proposal | Does the evidence name the configured pool and pair? |
| Remaining budget ≤ 100,000 total cap | Is the pool currently active and supported? |
| Unique proposal ID; rationale length | Is there an active suspension, exploit, deprecation or material warning? |
| 1–3 distinct public `https://` URLs ≤ 300 chars | Do authoritative sources conflict? |
| Evidence size limits, fetch retry, unavailable-source handling | |
| **Findings → status** via a fixed decision table; reason codes | |
| Validator audit that the leader's status equals `derive(findings)` | |
| Budget arithmetic in `u256`; owner-only cancellation | |

The model never outputs an amount. It reports findings. The contract turns the
findings into the status, and code alone decides what that status does to the
budget.

## The consequential state transition

```text
evaluate_proposal ──► deterministic gate ──fail──► revert (FINISHED_WITH_ERROR), nothing stored
                              │ pass
                              ▼
               leader + validators each: fetch → assess → derive status
                              │ consensus on status
                              ▼
  COMPLIANT              → record stored, reserved += amount, authorization = RESERVED
  NON_COMPLIANT          → record stored, reserved unchanged
  INSUFFICIENT_EVIDENCE  → record stored, reserved unchanged
cancel_authorization (owner) → reserved -= reservation, authorization = CANCELLED
```

## Live deployment

| Item | Value |
| --- | --- |
| App | https://mandate-gate-azure.vercel.app |
| Evidence fixtures | https://mandate-gate-azure.vercel.app/evidence/ (synthetic, labelled) |
| Contract | [`0xA8a0Af05833A431bb59b9A2D8B565FD3E344E3e0`](https://explorer-studio-dev.genlayer.com/address/0xA8a0Af05833A431bb59b9A2D8B565FD3E344E3e0) |
| Deploy tx | [`0x946a2c34…ac26389`](https://explorer-studio-dev.genlayer.com/tx/0x946a2c348b9ce1ff69ce6c12801195d46dcbc417e878d47795c21a999ac26389) |
| Network | Studio Next · `studioDevnet` · chain 61997 · `https://studio-dev.genlayer.com/api` |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (GenVM v0.6.0-rc5) |
| Tooling | CLI 0.40.0-rc.3 · genlayer-js 2.0.0-rc.1 · transaction-kit 0.1.0-rc.2 · genlayer-py 0.19.0rc2 · genlayer-test 0.30.0rc2 · genvm-linter 0.11.1rc2 |

## Proof transactions

All transactions below are real Studio Next transactions:

- The scripted cases were produced by `npm run seed:demo` and recorded in [`deploy/proof.json`](deploy/proof.json), with full receipts in `artifacts/`.
- The UI cases were submitted and cancelled through the web app with an injected wallet.
- Every case is **FINALIZED**. Each result was checked against the execution result and then read back from contract state.
- Each LLM-backed case was decided by 5 validators with consensus *Accepted*.

| # | Case | Transaction | Execution | Status / reason codes | Reserved before → after |
| --- | --- | --- | --- | --- | --- |
| 1 | Active pool fixture, 20,000 | [`0x815ef375…3e6a17e`](https://explorer-studio-dev.genlayer.com/tx/0x815ef37599f73b1beeeb63492465325edc951d4c18306ecae2c02befc3e6a17e) | FINISHED_WITH_RETURN | **COMPLIANT** · IDENTITY_CONFIRMED, POOL_ACTIVE_SUPPORTED, NO_ADVERSE_REPORTS | 0 → **20,000** |
| 2 | Exploit/suspension fixture, 15,000 | [`0x0d00b374…1b45e24`](https://explorer-studio-dev.genlayer.com/tx/0x0d00b374b20875e99b7ce99a7f3771f76035034ef54db089e70286da91b45e24) | FINISHED_WITH_RETURN | **NON_COMPLIANT** · ADVERSE_REPORT, POOL_NOT_ACTIVE | 20,000 → 20,000 |
| 3 | Different-pool fixture, 12,000 | [`0x9ea39506…0baec859818`](https://explorer-studio-dev.genlayer.com/tx/0x9ea39506ea8e1eb5acfd08763eb27d061a782ce963db5810bd5f30baec859818) | FINISHED_WITH_RETURN | **INSUFFICIENT_EVIDENCE** · IDENTITY_MISMATCH | 20,000 → 20,000 |
| 4 | Over-cap, 30,000 | [`0xfb634d64…3c6b598`](https://explorer-studio-dev.genlayer.com/tx/0xfb634d647481715880b74125d674b1cf7114d37863ed7d21076239e6b3c6b598) | FINISHED_WITH_ERROR | Deterministic revert `[LIMIT] amount 30000 exceeds the per-proposal cap of 25000`. No record | 20,000 → 20,000 |
| 5 | Second authorization, 5,000 | [`0xce6b382a…486c08f76`](https://explorer-studio-dev.genlayer.com/tx/0xce6b382a2a121057f9daa8437b562d7fb7aaed159d5612b25cc8547486c08f76) | FINISHED_WITH_RETURN | **COMPLIANT** | 20,000 → 25,000 |
| 6 | Owner cancels #5 | [`0x0e8046b7…be550dbcd5f`](https://explorer-studio-dev.genlayer.com/tx/0x0e8046b7a275bd889ea12f8d5b9819dd91f1d441a250098760a54be550dbcd5f) | FINISHED_WITH_RETURN | authorization **CANCELLED**, 5,000 released | 25,000 → 20,000 |
| 7 | Ownership handed to test wallet | [`0xdf2cbb15…1596cd5c`](https://explorer-studio-dev.genlayer.com/tx/0xdf2cbb1592753fe58ea5608968ef6c42d80eed42e1acf893de138d041596cd5c) | FINISHED_WITH_RETURN | owner = `0x2Ea195AE…0AeEBF` | 20,000 → 20,000 |
| 8 | **UI**: dev wallet submits the Active pool fixture, 5,000 | [`0x270d6580…51c9dc8c`](https://explorer-studio-dev.genlayer.com/tx/0x270d65801d2ca34bb075e710da00b3bab36ec46704aaaccd440262d451c9dc8c) | FINISHED_WITH_RETURN | **COMPLIANT**, shown first as "Decided · not yet final", then finalized | 20,000 → 25,000 |
| 9 | **UI**: owner clicks Cancel on #8 | [`0x8e5d83c0…e247e87d`](https://explorer-studio-dev.genlayer.com/tx/0x8e5d83c0dd75654baa249a657d69521b22dde96ab1d6967057374868e247e87d) | FINISHED_WITH_RETURN | authorization **CANCELLED** | 25,000 → 20,000 |

Final state after the scripted run: total 100,000 · reserved 20,000 · available 80,000.
The 20,000 reservation belongs to proposal 1.

The validator reasoning recorded on-chain for case 3 was:

> "…explicitly identifies pool HBX-WETH-USDT-5BP with pair WETH/USDT, which does not match the configured pool ID (HBX-WETH-USDC-5BP) or pair (WETH/USDC)…"

Earlier deployment `0x3cD1A3AD…066b8f64` is superseded by the ownership-transfer
upgrade. It produced the same four outcomes, plus one UI-submitted
INSUFFICIENT_EVIDENCE decision ([`0x120dd426…81a68a5b`](https://explorer-studio-dev.genlayer.com/tx/0x120dd426535ec6b833d2f02e83cff2cb1fb7fe4662f3f7f7801797a481a68a5b)).
Those records are archived in `deploy/history/`.

## Architecture summary

- **Contract**: one Python file.
  - Storage uses `TreeMap[str, str]` for canonical JSON records, `DynArray[str]` for order, and `u256` for budget and counters. There are no floats.
  - `gl.vm.run_nondet` (the v0.6 successor of `run_nondet_unsafe`) takes a leader function and a validator function. The validator deterministically audits the leader's result, then independently refetches the evidence, re-asks the LLM and compares status.
  - State is written only after consensus.
- **Frontend**: a static Next.js 16 page.
  - An account-free GenLayerJS client handles reads.
  - The Transaction Kit quotes fees and submits through an injected EIP-1193 wallet, with a chain and account guard.
  - A 5 s lifecycle poller respects the Studio Next rate limit.
  - Execution-result verification is followed by a contract read-back, and "Decided · not yet final" is labelled separately from finalized state.
- **Evidence**: three static pages on the app's domain, configured on-chain as the designated demo status registry. Reviewers can also submit any live HTTPS source.
- **Tooling**: deploy, seed, smoke, fee-estimate and ownership-transfer scripts, all pinned to the Studio Next RC family.

Details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## 60-second reviewer demo

1. **(0–10 s)** Open the app. Point out the frozen mandate, the configured pair
   and pool, and the budget of 100,000 total, 20,000 reserved and 80,000
   available. Note that it all loads without a wallet.
2. **(10–25 s)** In the history, click `demo-active-001`, `demo-warning-001` and
   `demo-ambiguous-001` in turn. Each shows its status, the validators'
   reasoning, stable reason codes and the evidence they fetched. Only the first
   reserved budget.
3. **(25–45 s)** Connect a wallet. Switch to Studio Next, and use **Get test GEN**
   if needed. Click **Exploit warning fixture** and submit 10,000.
   - Watch the lifecycle move from fee quote through signature, queued and
     validators to decided. The reserved figure does not move.
   - Optionally submit the **Active pool fixture** and watch reserved rise by
     exactly the amount.
4. **(45–55 s)** Enter 30,000 as the amount. The form blocks it, and the contract
   enforces the same rule on its own: see proof #4, a `FINISHED_WITH_ERROR` with
   the `[LIMIT]` message.
5. **(55–60 s)** Open the contract and a transaction in the explorer from the
   links in the decision panel.

## Honest limitations

- **Studio Next is a resettable development network.** If it resets, the
  contract and history disappear. Recovery steps are below.
- **The fixtures are synthetic.** The prompt tells validators that the app's own
  domain is the designated demo registry. Authority for other sources is judged
  by the LLM, which is subjective, and that is the point. It also means results
  on arbitrary live pages can vary, and a disagreeing round ends UNDETERMINED
  with nothing written.
- **Consensus compares status only.** Reasoning prose and the choice of
  supporting URLs are informational and may differ between validators.
- **Evidence handling is plain `web.get`** with HTML stripped to text, capped at
  7,000 characters per source. JavaScript-rendered pages may appear empty and
  are then treated as unavailable.
- **One pool, one mandate, one budget.** There is no mandate versioning,
  multi-pool support, expiry of authorizations, or real asset movement.
- **Owner-only cancellation.** The owner is currently the local test-harness
  wallet. Run `npm run owner:transfer -- <your address>` to move it to your own
  wallet.
- **Rate limits.** Studio Next allows 30 RPC requests per minute per IP. The app
  and scripts retry after the server's hint, but heavy concurrent use from one
  IP will be slow.

## Reset and redeployment

```bash
npm install && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
npm run demo:reset          # deploy (verified) + seed all proofs → lib/deployment.json, deploy/proof.json
npm run smoke               # read-only live verification
npx vercel deploy --prod    # ship the frontend with the new address
npm run owner:transfer -- 0xYourWallet   # optional: become the owner in the UI
```

The deploy and seed scripts create and fund their own git-ignored key from the
Studio Next faucet, so no manual signature is needed.
