/**
 * Studio Next smoke test (read-only). Verifies:
 *  - the RPC is Studio Next (chain 61997) and accepts the pinned runner header,
 *  - the deployed contract answers with the expected version, mandate and caps,
 *  - every proof transaction in deploy/proof.json is FINALIZED with the recorded
 *    execution result, and each recorded decision still reads back from the contract,
 *  - the budget identity reserved + available = total holds and equals the sum of
 *    active reservations.
 */
import { readFile } from 'node:fs/promises';
import { chain, demo, readClient, readJson, read, loadDeployment, statusName, executionName, PROOF_PATH } from './lib.mjs';

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const client = readClient();
check((await client.getChainId()) === 61997, `RPC ${chain.rpcUrls.default.http[0]} is chain 61997`);
const code = await readFile(new URL('../contracts/mandate_gate.py', import.meta.url), 'utf8');
try {
  await client.getContractSchemaForCode(new TextEncoder().encode(code));
  check(true, `runner accepted: ${code.split('\n', 1)[0]}`);
} catch (error) {
  check(false, `runner/schema rejected: ${error.message.slice(0, 200)}`);
}

const deployment = await loadDeployment();
const address = deployment.contract;
check((await read(address, 'get_version')) === 'mandate-gate/1.0', `contract ${address} version`);
const mandate = await readJson(address, 'get_mandate');
check(mandate.mandate_text === demo.mandateText, 'frozen mandate text matches config/demo.json');
check(mandate.pair === demo.pair && mandate.pool_id === demo.poolId, `configured ${mandate.pair} / ${mandate.pool_id}`);
const budget = await readJson(address, 'get_budget');
check(budget.total_cap === 100000 && budget.per_proposal_cap === 25000, 'caps 100,000 total / 25,000 per proposal');
check(budget.reserved + budget.available === budget.total_cap, `reserved ${budget.reserved} + available ${budget.available} = total`);
const list = await readJson(address, 'list_proposals', [0, 50]);
const activeSum = list.items.filter((p) => p.authorization === 'RESERVED').reduce((s, p) => s + p.reserved_amount, 0);
check(activeSum === budget.reserved, `sum of active reservations (${activeSum}) equals reserved`);

const proof = JSON.parse(await readFile(PROOF_PATH, 'utf8'));
check(proof.contract === address, 'deploy/proof.json belongs to the deployed contract');
for (const c of proof.cases) {
  const tx = await client.getTransaction({ hash: c.transaction });
  const ok = statusName(tx) === 'FINALIZED' && executionName(tx) === c.execution;
  check(ok, `${c.key}: ${c.transaction.slice(0, 12)}… ${statusName(tx)} / ${executionName(tx)}`);
  if (c.proposalId && c.expected !== 'REVERT') {
    const p = list.items.find((i) => i.proposal_id === c.proposalId);
    check(p?.status === c.expected, `${c.key}: on-chain status ${p?.status}`);
  }
}
for (const c of proof.uiCases ?? []) {
  const tx = await client.getTransaction({ hash: c.transaction });
  check(statusName(tx) === 'FINALIZED' && executionName(tx) === 'FINISHED_WITH_RETURN', `${c.key}: ${c.transaction.slice(0, 12)}… ${statusName(tx)} / ${executionName(tx)}`);
  const p = list.items.find((i) => i.proposal_id === c.proposalId);
  check(c.authorization ? p?.authorization === c.authorization : p?.status === c.status, `${c.key}: on-chain ${p?.status} / ${p?.authorization}`);
}
console.log(failures ? `${failures} check(s) failed` : 'All smoke checks passed');
process.exitCode = failures ? 1 : 0;
