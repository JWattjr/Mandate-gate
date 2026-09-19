# MandateGate architecture

MandateGate is one Python intelligent contract, one static Next.js page, three
static evidence fixtures, and Node scripts for deployment, seeding and smoke
checks. There is no backend, no database and no custody. It is an authorization
prototype only.

```text
 reviewer browser (Next.js, static)                    Studio Next (chain 61997)
 ┌─────────────────────────────────┐   reads (account-free)   ┌───────────────────────────────┐
 │ budget · mandate · history      │ ───────────────────────▶ │ MandateGate contract          │
 │ proposal form                   │                          │  deterministic gate           │
 │ decision + lifecycle panel      │  writes: Transaction Kit │  ├─ identity, caps, IDs, URLs │
 │ injected EIP-1193 wallet        │ ─ quote → sign → submit ▶│  nondeterministic block       │
 └─────────────────────────────────┘  track → verify → read   │  ├─ leader: fetch + LLM       │
                                                              │  └─ validators: refetch + LLM │
 mandate-gate-azure.vercel.app/evidence/*.html  ◀── HTTPS GET ─┤     compare status            │
 (synthetic fixtures, or any live HTTPS page)                 │  persist + reserve budget     │
                                                              └───────────────────────────────┘
```

## Contract: `contracts/mandate_gate.py`

The runner is pinned in the first line to
`py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (GenVM
v0.6.0-rc5). `npm run smoke` confirms it against the live Studio Next runner registry
through `gen_getContractSchemaForCode`.

### Storage

| Field | Type | Purpose |
| --- | --- | --- |
| `owner` | `Address` | Only this address can cancel an authorization or transfer ownership |
| `mandate_text`, `mandate_version` | `str` | Frozen at deployment. No setter exists |
| `pair`, `pool_id`, `registry_host` | `str` | Configured identity and the designated demo status registry |
| `total_cap`, `per_proposal_cap`, `reserved` | `u256` | Integer accounting units. No floats |
| `compliant_count` … `cancelled_count` | `u256` | Summary statistics |
| `proposals` | `TreeMap[str, str]` | Proposal ID → canonical JSON record (`sort_keys`) |
| `proposal_ids` | `DynArray[str]` | Insertion order for listing |

### `evaluate_proposal(proposal_id, pair, pool_id, amount, rationale, evidence_urls)`

1. **Deterministic gate.** All of these checks run before any validator work. Each failure raises a tagged `UserError`, the transaction reverts, and no state changes:
   - `[INPUT]`: the ID is 3–48 characters of `[A-Za-z0-9_-]`; the rationale is 12–600 characters; there are 1–3 distinct evidence URLs, each `https://`, public DNS host, no credentials, ports or whitespace, and at most 300 characters.
   - `[DUPLICATE]`: the proposal ID has already been adjudicated.
   - `[IDENTITY]`: the pair (case-insensitive) or the pool ID (exact) differs from the configured values.
   - `[LIMIT]`: the amount is not a positive integer, exceeds 25,000, or exceeds the remaining budget.
2. **Nondeterministic block** (`gl.vm.run_nondet`, the v0.6 successor of `run_nondet_unsafe`). The leader and each validator run the same `assess(context)`:
   - They fetch each URL with `gl.nondet.web.get`. A failed fetch is retried once. Non-200, empty, or oversized (>600 KB) bodies are recorded as unavailable with an error code. HTML is reduced to text and capped at 7,000 characters per source.
   - If no source is usable, the result is `INSUFFICIENT_EVIDENCE / EVIDENCE_UNAVAILABLE` and the LLM is not called.
   - Otherwise one JSON prompt carries the frozen mandate, the configured identity, the proposal, and the fetched text marked as untrusted data. The model returns **findings**: `identity`, `pool_state`, `adverse_report`, `authoritative_source`, `conflicting`, `supporting_urls`, and `reasoning`. A malformed reply is retried once. A second failure raises `[LLM_ERROR]`, the transaction reverts, the ID stays free, and the budget is untouched.
   - `derive(findings)` maps the findings to exactly one status and stable reason codes with a fixed decision order:

     | Condition (first match wins) | Status | Codes |
     | --- | --- | --- |
     | No usable source | INSUFFICIENT_EVIDENCE | EVIDENCE_UNAVAILABLE |
     | No authoritative source | INSUFFICIENT_EVIDENCE | NON_AUTHORITATIVE_EVIDENCE |
     | identity = MISMATCH / UNCLEAR | INSUFFICIENT_EVIDENCE | IDENTITY_MISMATCH / IDENTITY_UNCLEAR |
     | Authoritative sources conflict | INSUFFICIENT_EVIDENCE | CONFLICTING_EVIDENCE |
     | Adverse report and/or pool inactive | NON_COMPLIANT | ADVERSE_REPORT, POOL_NOT_ACTIVE |
     | pool_state UNCLEAR | INSUFFICIENT_EVIDENCE | POOL_STATE_UNCLEAR |
     | adverse_report UNCLEAR | INSUFFICIENT_EVIDENCE | INCOMPLETE_EVIDENCE |
     | Otherwise | COMPLIANT | IDENTITY_CONFIRMED, POOL_ACTIVE_SUPPORTED, NO_ADVERSE_REPORTS |

   - Supporting URLs are filtered to URLs that were both submitted and fetched.
3. **Validator function.** It does not just check JSON shape:
   - It audits the leader result deterministically: the status is one of the three, the codes and status equal `derive(leader.findings)`, the supporting URLs are a subset of the submitted URLs, and the reasoning is bounded.
   - It **independently re-runs `assess`**: it refetches the evidence, asks its own LLM, and derives its own status.
   - It agrees only if the statuses match exactly. Reasoning prose and the choice of supporting URLs may differ between validators without failing consensus.
   - If the leader failed with `[LLM_ERROR]`, the validator agrees only when it hits the same failure itself.
   - Any exception in the validator counts as disagreement.
4. **After consensus**, and only then, the contract writes state:
   - It persists the record: proposal, decision, findings and the per-source fetch log.
   - It increments the counter for that status.
   - Only on COMPLIANT, it re-checks the limits and adds `amount` to `reserved`.
   - NON_COMPLIANT and INSUFFICIENT_EVIDENCE never touch `reserved`.

### Other methods

- `cancel_authorization(id)` is owner-only. It requires `authorization == RESERVED`, subtracts exactly the reserved amount, and marks the record CANCELLED. The judgment stays in history.
- `transfer_ownership(address)` is owner-only.
- The views return canonical JSON: `get_version`, `get_mandate`, `get_budget`, `get_proposal`, `get_decision`, `list_proposals(offset, limit≤50)`, and `get_summary`.

### Failure classification

| Class | Example | Handling |
| --- | --- | --- |
| Expected | Duplicate ID, over-cap, wrong pool | Deterministic `UserError` before any web or LLM work. The transaction reverts (`FINISHED_WITH_ERROR`) |
| External | Evidence URL returns 503 or times out | Retried once, then recorded as unavailable. The decision cannot rest on it, and with no usable source the status is `INSUFFICIENT_EVIDENCE` |
| Transient | One validator's fetch fails | Retried once. If validators still disagree, the round rotates or ends UNDETERMINED with nothing written |
| LLM | Non-JSON or out-of-vocabulary reply | Retried once, then `[LLM_ERROR]` reverts cleanly, and the ID remains usable |

## Frontend

- `lib/genlayer.ts`:
  - Reads use an account-free `createClient({ chain: studioDevnet })`.
  - Writes use `@genlayer/transaction-kit` `estimate()` → `submit()` through the injected wallet. The provider is guarded, so it refuses to sign on the wrong chain or account.
  - Tracking polls `getTransaction` every 5 s. The kit's own `track()` polls every 2 s, which alone would use the 30 requests/minute limit.
  - A rate-limited response is retried after the server's `retry_after_seconds`.
- **Success is never inferred from lifecycle alone.** A decided transaction must report `FINISHED_WITH_RETURN` and not be `UNDETERMINED`. The UI then reads the proposal back from contract state.
  - A decided-but-not-final read is labelled "Decided · not yet final".
  - The finalized read replaces it.
  - Failed executions show the tagged contract error and "budget unchanged".
- The active transaction hash is kept in `localStorage`, so a reload resumes tracking.
- The `lib/mandate.ts` client-side checks mirror the contract's deterministic rules for fast feedback. The contract remains the authority.

## Evidence fixtures

`public/evidence/pool-active.html`, `pool-warning.html`, `pool-ambiguous.html`
are static pages on the app's own Vercel domain, which is configured on-chain as
`registry_host`. Each page carries a visible "SYNTHETIC REVIEWER FIXTURE" banner.
The prompt tells validators that this host is the treasury's designated demo
status registry and that the label is expected. The frontend sends only URLs.
Validators fetch the content themselves.

## Tooling (pinned Studio Next RC family, all released 2026-09-03)

| Component | Version |
| --- | --- |
| GenLayer CLI (`genlayer`) | 0.40.0-rc.3 (devDependency) |
| genlayer-js | 2.0.0-rc.1 |
| @genlayer/transaction-kit | 0.1.0-rc.2 |
| genlayer-py | 0.19.0rc2 |
| genlayer-test (direct mode, SDK v0.6.0-rc5) | 0.30.0rc2 |
| genvm-linter | 0.11.1rc2 |
| GenVM runner | py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng |
