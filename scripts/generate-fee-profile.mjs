/**
 * Build the Transaction Kit developer fee suggestions from real, finalized
 * Studio Next receipts already recorded in deploy/proof.json.
 *
 * This is read-only: it never submits a transaction. The three adjudication
 * branches are kept as provenance in the profile while `methods` contains the
 * headroom-adjusted maxima consumed by Transaction Kit.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chain, readClient, PROOF_PATH } from './lib.mjs';

const HEADROOM_NUMERATOR = 5n;
const HEADROOM_DENOMINATOR = 4n;
const profilePath = new URL('../fee-profile.json', import.meta.url);

const asBigInt = (value, label) => {
  if (value === undefined || value === null) throw new Error(`Missing ${label} in receipt`);
  return BigInt(value);
};

const ceilHeadroom = (value) =>
  ((value * HEADROOM_NUMERATOR) + HEADROOM_DENOMINATOR - 1n) / HEADROOM_DENOMINATOR;

function extractObservation(transaction, key) {
  const accounting = transaction.data?.fee_accounting ?? transaction.fee_accounting;
  if (!accounting) throw new Error(`${key}: receipt has no fee_accounting`);

  const report = accounting.execution_fee_report ?? {};
  const distribution =
    accounting.fees_distribution ??
    accounting.feesDistribution ??
    accounting.recommended_fee_preset?.distribution ??
    accounting.recommendedFeePreset?.distribution;
  if (!distribution) throw new Error(`${key}: receipt has no fee distribution`);

  const rotations = Array.isArray(distribution.rotations) && distribution.rotations.length
    ? distribution.rotations.map((value) => asBigInt(value, `${key}.rotations`))
    : [0n];
  const messageConsumed = asBigInt(accounting.message_fee_consumed ?? 0, `${key}.message_fee_consumed`);
  const genvmMessageConsumed = asBigInt(accounting.genvm_message_fee_consumed ?? 0, `${key}.genvm_message_fee_consumed`);
  const executionConsumed = asBigInt(accounting.execution_fee_consumed, `${key}.execution_fee_consumed`);
  const totalEstimatedFee = asBigInt(report.totalEstimatedFee, `${key}.execution_fee_report.totalEstimatedFee`);

  return {
    leaderTimeunitsAllocation: asBigInt(distribution.leaderTimeunitsAllocation, `${key}.leaderTimeunitsAllocation`),
    validatorTimeunitsAllocation: asBigInt(distribution.validatorTimeunitsAllocation, `${key}.validatorTimeunitsAllocation`),
    executionBudgetPerRound: executionConsumed + totalEstimatedFee,
    totalMessageFees: messageConsumed > genvmMessageConsumed ? messageConsumed : genvmMessageConsumed,
    rotationsPerRound: rotations.reduce((max, value) => (value > max ? value : max), 0n),
  };
}

function withHeadroom(observation) {
  return Object.fromEntries(
    Object.entries(observation).map(([key, value]) => [
      key,
      key === 'rotationsPerRound' ? value.toString() : ceilHeadroom(value).toString(),
    ]),
  );
}

const proof = JSON.parse(await readFile(PROOF_PATH, 'utf8'));
const cases = [
  { key: 'compliant', status: 'COMPLIANT' },
  { key: 'non_compliant', status: 'NON_COMPLIANT' },
  { key: 'insufficient', status: 'INSUFFICIENT_EVIDENCE' },
  { key: 'cancellation', status: 'CANCELLED' },
];
const records = [...(proof.cases ?? []), ...(proof.uiCases ?? [])];
const byKey = new Map(records.map((record) => [record.key, record]));
const client = readClient();
const measured = [];

for (const scenario of cases) {
  const record = byKey.get(scenario.key);
  if (!record?.transaction) throw new Error(`Missing proof transaction for ${scenario.key}`);
  const transaction = await client.getTransaction({ hash: record.transaction });
  const observed = extractObservation(transaction, scenario.key);
  measured.push({
    key: scenario.key,
    status: scenario.status,
    method: record.method ?? 'evaluate_proposal',
    transaction: record.transaction,
    observed: Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, value.toString()])),
    profiled: withHeadroom(observed),
  });
}

const maxima = new Map();
for (const sample of measured) {
  const current = maxima.get(sample.method) ?? {};
  const observed = Object.fromEntries(Object.entries(sample.observed).map(([key, value]) => [key, BigInt(value)]));
  for (const [key, value] of Object.entries(observed)) {
    if (current[key] === undefined || value > current[key]) current[key] = value;
  }
  maxima.set(sample.method, current);
}

const methods = Object.fromEntries(
  [...maxima.entries()].map(([method, values]) => [method, withHeadroom(values)]),
);
const profile = {
  version: 1,
  network: 'studio_devnet',
  chainId: chain.id,
  measuredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  headroom: 1.25,
  source: 'Finalized Studio Next receipts from deploy/proof.json; no transaction submitted by this script.',
  methods,
  scenarios: measured,
};

await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
console.log(`Wrote ${profilePath.pathname}`);
console.log(JSON.stringify({ methods, scenarios: measured.map(({ key, status, transaction }) => ({ key, status, transaction })) }, null, 2));
