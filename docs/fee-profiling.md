# Fee profiling

`fee-profile.json` is a chain-scoped Transaction Kit developer profile for
MandateGate's two write methods. It was generated on 2026-09-20 by
`npm run fees:profile`, which only reads the finalized Studio Next receipts
already recorded in `deploy/proof.json`; it does not submit a transaction or
change the deployed contract.

The profile includes measured receipts for the representative
`evaluate_proposal` outcomes `COMPLIANT`, `NON_COMPLIANT` and
`INSUFFICIENT_EVIDENCE`, plus the existing `cancel_authorization` receipt. The
`methods` section stores the per-method maxima with the pinned gltest fee
profile headroom of 1.25. The `scenarios` section preserves the source hash and
the unpadded observation for each branch so the values remain auditable.

The browser passes this profile to the pinned Transaction Kit RC. Transaction
Kit selects it only when `chainId` matches Studio Next (61997); fee prices and
the fee-policy verification are still read live from the network before a
wallet signs. Re-run `npm run fees:profile` after a new deployment, contract
bytecode change, or meaningful fee-policy change.

The direct-mode suite cannot produce a fee profile because it runs in-memory
and has no Studio receipt accounting. That is why the committed profile is
derived from real finalized receipts rather than an empty direct-test output.
