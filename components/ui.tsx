'use client';

import type { ReactNode } from 'react';
import {
  REASON_TEXT,
  STATUS_LABEL,
  shortHex,
  units,
  type Budget,
  type Mandate,
  type Proposal,
  type Status,
  type Summary,
} from '@/lib/mandate';
import { explorerAddress, explorerTx } from '@/lib/genlayer';
import { Gatekeeper, Icon, Sparkles, type IconName } from './art';

export { Mark } from './art';

export function Panel({
  title,
  meta,
  children,
  id,
  bodyless,
  className,
  icon,
  kicker,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  id?: string;
  bodyless?: boolean;
  className?: string;
  icon?: IconName;
  /** Small secondary display label shown above the factual title. */
  kicker?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <header className="panel-head">
        <div className="panel-heading">
          {icon ? (
            <span className="icon-tile" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div className="panel-titles">
            <h2 className="panel-title" id={id}>
              {kicker ? (
                <span className="kicker kicker-inline" aria-hidden="true">
                  {kicker}
                </span>
              ) : null}
              {title}
            </h2>
          </div>
        </div>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      {bodyless ? children : <div className="panel-body">{children}</div>}
    </section>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

const STATUS_ICON: Record<Status, IconName> = {
  COMPLIANT: 'check',
  NON_COMPLIANT: 'cross',
  INSUFFICIENT_EVIDENCE: 'question',
};

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status-pill ${status}`}>
      <Icon name={STATUS_ICON[status]} size={12} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- budget

export function BudgetPanel({ budget, loading, readLabel }: { budget: Budget | null; loading: boolean; readLabel: string }) {
  const reservedPct = budget ? Math.min(100, (budget.reserved / budget.total_cap) * 100) : 0;
  // One tick per per-proposal cap: each slot is the most a single proposal can reserve.
  const ticks = budget && budget.per_proposal_cap > 0 ? Math.floor(budget.total_cap / budget.per_proposal_cap) : 0;
  return (
    <Panel
      title="Treasury authorization budget"
      kicker="Resource status"
      icon="target"
      meta={readLabel}
      id="budget-title"
      bodyless
      className="budget-panel"
    >
      <div className="budget-figures">
        {(
          [
            ['Total cap', budget?.total_cap, 'total', 'target'],
            ['Reserved', budget?.reserved, 'reserved', 'lock'],
            ['Available', budget?.available, 'available', 'gate'],
          ] as const
        ).map(([label, value, cls, icon]) => (
          <div className={`figure ${cls}`} key={label}>
            <div className="figure-label">
              <span className="figure-marker" aria-hidden="true">
                <Icon name={icon} size={14} />
              </span>
              {label}
            </div>
            <div className="figure-value">
              {loading || value === undefined ? <Skeleton width={120} height={26} /> : units(value)}
            </div>
            <div className="figure-unit">accounting units</div>
          </div>
        ))}
      </div>
      <div className="panel-body">
        <div
          className="meter"
          role="meter"
          aria-label="Reserved share of the authorization cap"
          aria-valuemin={0}
          aria-valuemax={budget?.total_cap ?? 100}
          aria-valuenow={budget?.reserved ?? 0}
        >
          <span className="meter-fill" style={{ width: `${reservedPct}%` }} />
          {Array.from({ length: Math.max(0, ticks - 1) }, (_, i) => (
            <span key={i} className="meter-tick" style={{ left: `${((i + 1) / ticks) * 100}%` }} aria-hidden="true" />
          ))}
        </div>
        <div className="meter-legend">
          <span className="legend-item">
            <span className="swatch swatch-reserved" aria-hidden="true" />
            {budget ? `${reservedPct.toFixed(0)}% of the cap is reserved by COMPLIANT authorizations` : 'Reading budget…'}
          </span>
          <span className="legend-item">
            <span className="swatch swatch-tick" aria-hidden="true" />
            Per-proposal cap <b className="num">{budget ? units(budget.per_proposal_cap) : '…'}</b>
          </span>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- mandate

export function MandatePanel({ mandate, loading }: { mandate: Mandate | null; loading: boolean }) {
  return (
    <Panel
      title="Frozen mandate"
      kicker="Rulebook"
      icon="shield"
      className="rulebook-panel"
      meta={
        <span className="frozen-tag">
          <Icon name="lock" size={12} />
          Version {mandate?.mandate_version ?? '…'} · immutable
        </span>
      }
      id="mandate-title"
    >
      {loading || !mandate ? (
        <div className="skeleton-stack">
          <Skeleton />
          <Skeleton />
          <Skeleton width="70%" />
        </div>
      ) : (
        <div className="rulebook">
          <span className="seal" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <blockquote className="mandate-text">{mandate.mandate_text}</blockquote>
        </div>
      )}
      <p className="hint mandate-note">
        Stored in the contract at deployment. No method can change it. Every adjudication quotes this text to the
        validators verbatim.
      </p>
    </Panel>
  );
}

export function ConfigPanel({
  mandate,
  contract,
  deployTx,
  venue,
}: {
  mandate: Mandate | null;
  contract: string;
  deployTx: string;
  venue: string;
}) {
  return (
    <Panel title="Configured target" icon="map" id="config-title" className="side-panel">
      <dl className="kv">
        <dt>Token pair</dt>
        <dd className="mono">{mandate?.pair ?? '…'}</dd>
        <dt>Pool ID</dt>
        <dd className="mono">{mandate?.pool_id ?? '…'}</dd>
        <dt>Venue</dt>
        <dd>{venue}</dd>
        <dt>Status registry</dt>
        <dd className="mono">{mandate?.registry_host ?? '…'}</dd>
        <dt>Contract</dt>
        <dd className="mono">
          <ExtLink href={explorerAddress(contract)}>{shortHex(contract, 8, 6)}</ExtLink>
        </dd>
        <dt>Owner</dt>
        <dd className="mono">{mandate ? shortHex(mandate.owner, 8, 6) : '…'}</dd>
        <dt>Deploy tx</dt>
        <dd className="mono">
          <ExtLink href={explorerTx(deployTx)}>{shortHex(deployTx, 8, 6)}</ExtLink>
        </dd>
      </dl>
    </Panel>
  );
}

export function StatsPanel({ summary }: { summary: Summary | null }) {
  const cells: [string, number | undefined, string, IconName][] = [
    ['Compliant', summary?.compliant, 'ok', 'check'],
    ['Non-compliant', summary?.non_compliant, 'bad', 'cross'],
    ['Insufficient evidence', summary?.insufficient_evidence, 'warn', 'question'],
    ['Cancelled authorizations', summary?.cancelled, 'muted', 'undo'],
  ];
  return (
    <Panel
      title="Adjudications"
      icon="star"
      className="side-panel"
      meta={summary ? `${summary.proposals} recorded` : undefined}
      id="stats-title"
      bodyless
    >
      <div className="stats">
        {cells.map(([label, value, tone, icon]) => (
          <div className={`stat stat-${tone}`} key={label}>
            <span className="stat-icon" aria-hidden="true">
              <Icon name={icon} size={14} />
            </span>
            <b>{value ?? '–'}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function DivisionPanel() {
  return (
    <Panel title="Who decides what" icon="nodes" id="division-title" className="side-panel">
      <div className="split-line">
        <div className="split-col">
          <h3>
            <Icon name="gear" size={16} />
            Contract code (deterministic)
          </h3>
          <ul>
            <li>Pair and pool identity, unique proposal ID</li>
            <li>Positive integer amount, 25,000 per proposal</li>
            <li>100,000 total cap and remaining budget</li>
            <li>1–3 public HTTPS URLs, input sizes</li>
            <li>Findings → status mapping, budget arithmetic</li>
          </ul>
        </div>
        <div className="split-col">
          <h3>
            <Icon name="nodes" size={16} />
            GenLayer validators (consensus)
          </h3>
          <ul>
            <li>Fetch every evidence URL themselves</li>
            <li>Read it against the frozen mandate</li>
            <li>Agree on the resulting status or the round fails</li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- verdict

export function Verdict({
  proposal,
  finality,
  celebrate = false,
}: {
  proposal: Proposal;
  finality: 'final' | 'decided';
  /** Play the one-shot sparkle (only for a freshly finalized COMPLIANT result). */
  celebrate?: boolean;
}) {
  const used = new Set(proposal.supporting_urls);
  const effect =
    proposal.authorization === 'RESERVED'
      ? `${units(proposal.reserved_amount)} units reserved against the budget`
      : proposal.authorization === 'CANCELLED'
        ? 'Authorization cancelled by the owner; reservation released'
        : 'Budget unchanged; nothing reserved';
  const mood = proposal.status === 'COMPLIANT' ? 'happy' : proposal.status === 'NON_COMPLIANT' ? 'concerned' : 'idle';
  return (
    <div className="verdict">
      <div className={`verdict-banner ${proposal.status}`}>
        {celebrate && proposal.status === 'COMPLIANT' && finality === 'final' ? <Sparkles /> : null}
        <Gatekeeper mood={mood} size={56} className="verdict-mascot" />
        <div className="verdict-copy">
          <div className="verdict-status">
            <Icon name={STATUS_ICON[proposal.status]} size={20} />
            {proposal.status}
          </div>
          <div className="verdict-effect">{effect}</div>
        </div>
        <span className={`finality-tag ${finality}`}>
          <Icon name={finality === 'final' ? 'flag' : 'bolt'} size={12} />
          {finality === 'final' ? 'Finalized state' : 'Decided · not yet final'}
        </span>
      </div>
      <dl className="tx-grid">
        <dt>Proposal</dt>
        <dd className="mono">{proposal.proposal_id}</dd>
        <dt>Amount</dt>
        <dd className="num">{units(proposal.amount)} units</dd>
        <dt>Proposer</dt>
        <dd className="mono">{shortHex(proposal.proposer, 8, 6)}</dd>
        <dt>Rationale</dt>
        <dd>{proposal.rationale}</dd>
      </dl>
      <div>
        <p className="section-label">Validator reasoning</p>
        <p className="reasoning">{proposal.reasoning}</p>
      </div>
      <div>
        <p className="section-label">Reason codes</p>
        <ul className="codes">
          {proposal.reason_codes.map((code) => (
            <li className="code" key={code}>
              <b>{code}</b>
              <span>{REASON_TEXT[code] ?? ''}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="section-label">Evidence fetched by validators</p>
        <ul className="source-list">
          {proposal.evidence_urls.map((url) => {
            const log = proposal.sources.find((s) => s.url === url);
            const flag = log && !log.ok ? 'failed' : used.has(url) ? 'used' : '';
            return (
              <li key={url}>
                <span className={`src-flag ${flag}`}>
                  {log && !log.ok ? log.error || 'FAILED' : used.has(url) ? 'SUPPORTS' : 'FETCHED'}
                </span>
                <ExtLink href={url}>{url}</ExtLink>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- history

export type HistoryFilter = 'all' | 'reserved' | 'rejected';

export function HistoryPanel({
  proposals,
  loading,
  filter,
  onFilter,
  selectedId,
  onSelect,
  isOwner,
  onCancel,
  busy,
}: {
  proposals: Proposal[];
  loading: boolean;
  filter: HistoryFilter;
  onFilter: (f: HistoryFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isOwner: boolean;
  onCancel: (id: string) => void;
  busy: boolean;
}) {
  const rows = proposals.filter((p) =>
    filter === 'reserved' ? p.authorization === 'RESERVED' : filter === 'rejected' ? p.status !== 'COMPLIANT' : true,
  );
  return (
    <Panel
      title="Proposal and authorization history"
      kicker="Mission log"
      icon="log"
      id="history-title"
      className="history-panel"
      bodyless
      meta={
        <div className="filters" role="group" aria-label="Filter history">
          {(['all', 'reserved', 'rejected'] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => onFilter(f)}>
              {f === 'all' ? 'All' : f === 'reserved' ? 'Active reservations' : 'Not authorized'}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="panel-body skeleton-stack">
          <Skeleton />
          <Skeleton />
          <Skeleton width="60%" />
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <Gatekeeper mood="idle" size={64} />
          <strong>{proposals.length === 0 ? 'No proposals adjudicated yet' : 'Nothing matches this filter'}</strong>
          <span>
            {proposals.length === 0
              ? 'Submit the first proposal above. Its decision will be recorded here after consensus.'
              : 'Choose another filter to see the rest of the history.'}
          </span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="history">
            <thead>
              <tr>
                <th>Proposal</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Authorization</th>
                <th>Decided</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.proposal_id} className={selectedId === p.proposal_id ? 'selected' : ''}>
                  <td data-col="id">
                    <button type="button" className="row-link" onClick={() => onSelect(p.proposal_id)}>
                      {p.proposal_id}
                    </button>
                  </td>
                  <td data-col="status">
                    <StatusPill status={p.status} />
                  </td>
                  <td data-col="amount" className="num">
                    {units(p.amount)}
                  </td>
                  <td data-col="auth">
                    <span className={`auth-tag ${p.authorization}`}>
                      {p.authorization === 'RESERVED' ? <Icon name="lock" size={12} /> : null}
                      {p.authorization === 'CANCELLED' ? <Icon name="undo" size={12} /> : null}
                      {p.authorization === 'RESERVED'
                        ? `Reserved ${units(p.reserved_amount)}`
                        : p.authorization === 'CANCELLED'
                          ? 'Cancelled'
                          : 'None'}
                    </span>
                  </td>
                  <td data-col="when" className="hint">
                    {p.decided_at
                      ? new Date(p.decided_at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
                      : '–'}
                  </td>
                  <td data-col="action">
                    {p.authorization === 'RESERVED' ? (
                      <button
                        type="button"
                        className="btn danger small"
                        disabled={!isOwner || busy}
                        title={isOwner ? 'Release this reservation' : 'Only the contract owner can cancel an authorization'}
                        onClick={() => onCancel(p.proposal_id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
