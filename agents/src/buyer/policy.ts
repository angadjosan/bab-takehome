/**
 * Buyer spending-limit policy. The buyer agent may only spend (purchase prices + dispute bonds) up to a
 * persisted budget. The ledger file is updated only after a transaction succeeds; checks happen
 * before any approval or transaction is sent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LedgerEntry {
  kind: 'purchase' | 'bond';
  amount: string; // base units
  ref: string; // purchaseId / disputeId
  versionId?: string;
  txHash?: string;
  at: string;
}

export interface Ledger {
  budget: string; // base units
  spent: string; // base units
  entries: LedgerEntry[];
}

export class SpendingLimitError extends Error {}

export class SpendingPolicy {
  constructor(private readonly file: string) {}

  load(): Ledger | null {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Ledger;
  }

  private save(l: Ledger): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Set the total budget (base units). Lowering it below the spent total is allowed (it blocks further spend). */
  setBudget(budget: bigint): Ledger {
    if (budget < 0n) throw new SpendingLimitError('budget must be non-negative');
    const l = this.load() ?? { budget: '0', spent: '0', entries: [] };
    l.budget = budget.toString();
    this.save(l);
    return l;
  }

  spent(): bigint {
    return BigInt(this.load()?.spent ?? '0');
  }

  remaining(): bigint {
    const l = this.load();
    if (!l) return 0n;
    const r = BigInt(l.budget) - BigInt(l.spent);
    return r > 0n ? r : 0n;
  }

  /**
   * Throws SpendingLimitError unless spending `amount` stays within the budget and (for purchases)
   * `amount <= maxPrice`.
   */
  authorize(amount: bigint, opts: { maxPrice?: bigint } = {}): void {
    const l = this.load();
    if (!l) throw new SpendingLimitError(`no budget configured (${this.file}); pass --budget`);
    if (amount <= 0n) throw new SpendingLimitError('amount must be positive');
    if (opts.maxPrice !== undefined && amount > opts.maxPrice) {
      throw new SpendingLimitError(`price ${amount} exceeds max price ${opts.maxPrice}`);
    }
    const spent = BigInt(l.spent);
    const budget = BigInt(l.budget);
    if (spent + amount > budget) {
      throw new SpendingLimitError(`spending ${amount} would exceed budget: spent ${spent} + ${amount} > ${budget}`);
    }
  }

  /** Record a successful spend (re-checks the limit). */
  record(entry: Omit<LedgerEntry, 'amount' | 'at'> & { amount: bigint }): Ledger {
    this.authorize(entry.amount);
    const l = this.load()!;
    if (l.entries.some((e) => e.kind === entry.kind && e.ref === entry.ref)) {
      throw new SpendingLimitError(`${entry.kind} ${entry.ref} already recorded`);
    }
    l.spent = (BigInt(l.spent) + entry.amount).toString();
    l.entries.push({ ...entry, amount: entry.amount.toString(), at: new Date().toISOString() });
    this.save(l);
    return l;
  }
}
