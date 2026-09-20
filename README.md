# MandateGate

**An on-chain authorization gate for a treasury liquidity allocation, adjudicated by GenLayer validators against a frozen natural-language mandate.**

A treasury is considering one liquidity allocation into one configured pool
(`WETH/USDC`, pool `HBX-WETH-USDC-5BP` on the synthetic "Harbor Exchange").
Every proposal gets exactly one status: `COMPLIANT`, `NON_COMPLIANT` or
`INSUFFICIENT_EVIDENCE`. Only a COMPLIANT decision reserves the proposed amount
against the contract's 100,000-unit authorization budget.

> **Authorization prototype. No assets are held or deployed.** Amounts are
> accounting units. There is no custody, DEX integration, swap, bridge, price feed,
> backend or database.

- **Live app:** https://mandate-gate-azure.vercel.app
- **Network:** GenLayer Studio Next (`studioDevnet`, chain 61997, RPC `https://studio-dev.genlayer.com/api`)
- **Contract:** see [`lib/deployment.json`](lib/deployment.json). Proof transactions are in [`deploy/proof.json`](deploy/proof.json) and [PORTAL_SUBMISSION.md](PORTAL_SUBMISSION.md).
- **Evidence fixtures:** https://mandate-gate-azure.vercel.app/evidence/

## How a proposal is decided

1. **Deterministic code** checks everything a rule can decide:
   - the configured pair and pool
   - a positive integer amount of at most 25,000 per proposal
   - the remaining budget under the 100,000 cap
   - a unique proposal ID
   - a rationale of 12–600 characters
   - 1–3 public HTTPS evidence URLs of at most 300 characters each

   Any failure reverts before validators do any work.
2. **GenLayer validators** each fetch the submitted evidence themselves. They
   read it against the frozen mandate and report findings: identity, pool state,
   adverse reports, authority and conflict.
3. **A fixed decision procedure** in the contract turns those findings into one
   status and stable reason codes. A validator agrees with the leader only if its
   own independent assessment reaches the same status.
4. **After consensus**, the decision is stored. COMPLIANT reserves budget. The
   other two statuses leave the budget unchanged. The owner can cancel an
   authorization, which releases its reservation.

See [ARCHITECTURE.md](ARCHITECTURE.md) for storage, the validator function, the decision table and failure classes.

## Repository

| Path | Contents |
| --- | --- |
| `contracts/mandate_gate.py` | The intelligent contract (runner pinned on line 1) |
| `tests/direct/` | 55 direct-mode contract tests (gltest 0.30.0rc2, SDK v0.6.0-rc5) |
| `tests/app/` | Frontend unit tests for client-side validation and error mapping |
| `app/`, `components/`, `lib/` | Next.js command center |
| `public/evidence/` | Three synthetic, clearly labelled evidence fixtures |
| `config/demo.json` | Mandate text, pair, pool, caps, fixture URLs, explorer |
| `scripts/` | deploy, seed, smoke, fee estimate/profile, ownership transfer, dev-wallet test harness |
| `deploy/proof.json` | Real transaction hashes, execution results and budget before/after |

## Setup

Requires Node ≥ 22.13 and Python ≥ 3.11 (tested on 3.14).

```bash
npm install
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
```

The contract npm scripts automatically prefer `.venv` when it exists, so the
pinned GenLayer tools are used without shell activation. The fallback is the
platform `python` command after a normal virtual-environment setup.

## Checks

```bash
npm run contract:lint   # genvm-linter 0.11.1rc2
npm run contract:test   # 55 direct tests
npm run lint
npm run typecheck
npm run test:app
npm run build
npm run fees:profile      # read-only measured profile from finalized proof receipts
npm run smoke           # live, read-only Studio Next checks against deploy/proof.json
```

`npm run check` runs every step except `smoke`.

## Deploy and seed (one command, safe after a Studio Next reset)

```bash
npm run demo:reset
```

This runs the following steps:

1. `scripts/deploy.mjs --fresh` creates or reuses the git-ignored key
   `.keys/deployer.key` and tops it up from the Studio Next faucet. It
   schema-checks the source against the live runner, quotes fees through the
   Transaction Kit, and deploys. It waits for FINALIZED, requires
   `FINISHED_WITH_RETURN`, reads the configuration back, and writes
   `lib/deployment.json`.
2. `scripts/seed-demo.mjs` submits the proof proposals and waits for
   finality on each. It verifies status and budget deltas from contract state
   and writes `deploy/proof.json`:
   - COMPLIANT
   - NON_COMPLIANT
   - INSUFFICIENT_EVIDENCE
   - a deterministic over-cap revert
   - a second COMPLIANT that the owner then cancels

   It is idempotent, so re-running it skips proven steps.

Then rebuild and redeploy the frontend so it picks up the new address:

```bash
npx vercel deploy --prod
```

To use the owner-only Cancel control from your own wallet:

```bash
npm run owner:transfer -- 0xYourWalletAddress
```

No private key is printed or committed. Scripts respect Studio Next's
30 requests/minute limit by pacing requests and honouring `retry_after`.

## Using the app

- Reading works without a wallet.
- To submit, connect an injected EIP-1193 wallet. The app offers to add and
  switch to Studio Next, chain 61997. If your balance is low, **Get test GEN**
  calls the Studio Next development faucet. Writes take a refundable fee
  deposit of about 0.175 GEN, and almost all of it is returned at finalization.
- Use the fixture chips to load the active, warning or different-pool evidence,
  or paste any live HTTPS source.
- The decision panel shows each stage:
  - fee quote, signature, queue, validators, decided, finalized
  - execution result
  - status, reasoning and reason codes
  - the evidence each validator fetched
  - transaction and contract explorer links

## Browser verification without an extension

`npm run dev-wallet` starts a localhost-only signer that holds a throwaway,
faucet-funded key. Pasting `scripts/dev-wallet-inject.js` into the page console
announces it as an EIP-6963 wallet. It starts on the wrong network, so the
switch flow is exercised too. This is a test harness only. It is how the UI
write path was verified end to end.
