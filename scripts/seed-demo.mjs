/**
 * Seed the deployed MandateGate with genuine proof transactions and record them
 * in deploy/proof.json:
 *
 *   1. COMPLIANT            - active-pool fixture       -> reserves budget
 *   2. NON_COMPLIANT        - exploit/suspension fixture -> budget unchanged
 *   3. INSUFFICIENT_EVIDENCE - different-pool fixture    -> budget unchanged
 *   4. deterministic over-cap rejection (30,000 > 25,000) -> reverts, budget unchanged
 *   5. owner cancellation: a second COMPLIANT authorization is reserved, then
 *      cancelled by the owner, releasing exactly its reservation
 *
 * Set MANDATEGATE_OWNER_ADDRESS to hand contract ownership to your own wallet
 * afterwards, so the frontend's owner-only Cancel control works for you.
 *
 * Every step waits for FINALIZED, checks the execution result, and reads the
 * contract state back. Nothing is inferred from the lifecycle status alone.
 * Re-running skips proposals that already exist on the current deployment.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createClient } from 'genlayer-js';
import {
  chain, demo, json, deployerAccount, ensureFunded, quote, describeFee, statusName, executionName,
  waitFor, readJson, loadDeployment, PROOF_PATH, explorerTx, explorerAddress,
} from './lib.mjs';

const deployment = await loadDeployment();
if (!deployment?.contract) throw new Error('Run npm run deploy:contract first.');
const address = deployment.contract;
const account = await deployerAccount();
const client = createClient({ chain, account });
await ensureFunded(account.address);
await mkdir(new URL('../deploy/', import.meta.url), { recursive: true });
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });

let proof = { contract: address, network: 'studioDevnet', chainId: chain.id, cases: [] };
try {
  const previous = JSON.parse(await readFile(PROOF_PATH, 'utf8'));
  if (previous.contract === address) proof = previous;
} catch {
  /* first run */
}
const save = () => writeFile(PROOF_PATH, json({ ...proof, updatedAt: new Date().toISOString() }) + '\n');

const rationale = (amount) =>
  `Allocate ${amount.toLocaleString('en-US')} idle treasury units into the configured WETH/USDC pool to earn swap fees.`;
const cases = [
  { key: 'compliant', expect: 'COMPLIANT', id: 'demo-active-001', amount: 20000, urls: [demo.fixtures.active] },
  { key: 'non_compliant', expect: 'NON_COMPLIANT', id: 'demo-warning-001', amount: 15000, urls: [demo.fixtures.warning] },
  { key: 'insufficient', expect: 'INSUFFICIENT_EVIDENCE', id: 'demo-ambiguous-001', amount: 12000, urls: [demo.fixtures.ambiguous] },
  { key: 'over_cap', expect: 'REVERT', id: 'demo-overcap-001', amount: 30000, urls: [demo.fixtures.active] },
  { key: 'cancel_setup', expect: 'COMPLIANT', id: 'demo-cancel-001', amount: 5000, urls: [demo.fixtures.active] },
];

async function exists(id) {
  try {
    return await readJson(address, 'get_proposal', [id]);
  } catch {
    return null;
  }
}

for (const c of cases) {
  const done = proof.cases.find((p) => p.key === c.key && p.verified);
  if (done) {
    console.log(`${c.key}: already proven (${done.transaction})`);
    continue;
  }
  const existing = c.expect === 'REVERT' ? null : await exists(c.id);
  if (existing) {
    console.log(`${c.key}: ${c.id} already on-chain as ${existing.status}; not resubmitting.`);
    continue;
  }
  const before = await readJson(address, 'get_budget');
  const args = [c.id, demo.pair, demo.poolId, c.amount, rationale(c.amount), c.urls];
  const tx = { kind: 'write', address, method: 'evaluate_proposal', args };
  const { estimate, feeArgs } = await quote(tx);
  console.log(`${c.key}: fee ${describeFee(estimate)}`);
  const hash = await client.writeContract({
    address,
    functionName: 'evaluate_proposal',
    args,
    value: 0n,
    leaderOnly: false,
    ...feeArgs,
  });
  console.log(`${c.key}: submitted ${hash}`);
  const record = { key: c.key, expected: c.expect, proposalId: c.id, amount: c.amount, evidence: c.urls, transaction: hash, explorer: explorerTx(hash), budgetBefore: before };
  proof.cases = proof.cases.filter((p) => p.key !== c.key).concat(record);
  await save();

  const receipt = await waitFor(hash, 'finalized');
  await writeFile(new URL(`../artifacts/receipt-${c.key}.json`, import.meta.url), json(receipt));
  record.lifecycle = statusName(receipt);
  record.execution = executionName(receipt);
  record.budgetAfter = await readJson(address, 'get_budget');
  if (c.expect === 'REVERT') {
    record.onChainProposal = await exists(c.id);
    record.verified =
      record.lifecycle === 'FINALIZED' &&
      record.execution !== 'FINISHED_WITH_RETURN' &&
      record.onChainProposal === null &&
      record.budgetAfter.reserved === before.reserved;
  } else {
    const proposal = await exists(c.id);
    record.status = proposal?.status;
    record.reasonCodes = proposal?.reason_codes;
    record.reasoning = proposal?.reasoning;
    record.authorization = proposal?.authorization;
    const delta = record.budgetAfter.reserved - before.reserved;
    record.reservedDelta = delta;
    record.verified =
      record.lifecycle === 'FINALIZED' &&
      record.execution === 'FINISHED_WITH_RETURN' &&
      proposal?.status === c.expect &&
      delta === (c.expect === 'COMPLIANT' ? c.amount : 0);
  }
  await save();
  console.log(`${c.key}: ${record.lifecycle} / ${record.execution} / status=${record.status ?? 'n/a'} / reserved ${before.reserved} -> ${record.budgetAfter.reserved} / verified=${record.verified}`);
}

async function ownerWrite(key, method, args, check) {
  const done = proof.cases.find((p) => p.key === key && p.verified);
  if (done) return console.log(`${key}: already proven (${done.transaction})`);
  const before = await readJson(address, 'get_budget');
  const { feeArgs } = await quote({ kind: 'write', address, method, args });
  const hash = await client.writeContract({ address, functionName: method, args, value: 0n, leaderOnly: false, ...feeArgs });
  console.log(`${key}: submitted ${hash}`);
  const record = { key, method, args, transaction: hash, explorer: explorerTx(hash), budgetBefore: before };
  proof.cases = proof.cases.filter((p) => p.key !== key).concat(record);
  const receipt = await waitFor(hash, 'finalized');
  await writeFile(new URL(`../artifacts/receipt-${key}.json`, import.meta.url), json(receipt));
  record.lifecycle = statusName(receipt);
  record.execution = executionName(receipt);
  record.budgetAfter = await readJson(address, 'get_budget');
  record.verified = record.lifecycle === 'FINALIZED' && record.execution === 'FINISHED_WITH_RETURN' && (await check(record));
  await save();
  console.log(`${key}: ${record.lifecycle} / ${record.execution} / reserved ${before.reserved} -> ${record.budgetAfter.reserved} / verified=${record.verified}`);
}

const setup = proof.cases.find((p) => p.key === 'cancel_setup' && p.verified);
if (setup) {
  await ownerWrite('cancellation', 'cancel_authorization', ['demo-cancel-001'], async (r) => {
    const p = await exists('demo-cancel-001');
    r.authorization = p?.authorization;
    r.releasedDelta = r.budgetBefore.reserved - r.budgetAfter.reserved;
    return p?.authorization === 'CANCELLED' && r.releasedDelta === 5000;
  });
}

const newOwner = process.env.MANDATEGATE_OWNER_ADDRESS?.trim();
if (newOwner && /^0x[0-9a-fA-F]{40}$/.test(newOwner)) {
  const mandate = await readJson(address, 'get_mandate');
  if (mandate.owner.toLowerCase() === newOwner.toLowerCase()) console.log(`Owner is already ${newOwner}.`);
  else if (mandate.owner.toLowerCase() !== account.address.toLowerCase())
    console.log(`Ownership already moved to ${mandate.owner}; not changing it.`);
  else
    await ownerWrite('ownership', 'transfer_ownership', [newOwner], async () =>
      (await readJson(address, 'get_mandate')).owner.toLowerCase() === newOwner.toLowerCase());
}

proof.finalBudget = await readJson(address, 'get_budget');
proof.summary = await readJson(address, 'get_summary');
proof.contractExplorer = explorerAddress(address);
await save();
console.log('Final budget:', JSON.stringify(proof.finalBudget));
const failed = proof.cases.filter((c) => !c.verified);
if (failed.length) {
  console.log(`Unverified cases: ${failed.map((c) => c.key).join(', ')} (see deploy/proof.json)`);
  process.exitCode = 1;
}
