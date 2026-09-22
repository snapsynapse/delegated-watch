
export const calendarDay = (timezone, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);

export const isCalendarDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function partitionCompleteReceipts(receipts, timezone, windowStart, now = new Date()) {
  const today = calendarDay(timezone, now);
  const errors = [];
  for (const receipt of receipts) {
    if (!isCalendarDate(receipt.date)) errors.push(`${receipt._where ?? "receipt"} has invalid calendar date`);
    else if (receipt.date > today) errors.push(`${receipt._where ?? "receipt"} has date ${receipt.date}, after the current day in ${timezone}`);
    else if (receipt.date < windowStart) errors.push(`${receipt._where ?? "receipt"} predates the recovery window`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    today,
    heldBack: receipts.filter((receipt) => receipt.date === today),
    receipts: receipts.filter((receipt) => receipt.date < today)
  };
}

export function assertHistoricalPreservation(before, after, { excludedSources = [], correction = null } = {}) {
  // Existing fingerprinted exclusions are independently checked against exact
  // counters before this function is called. A generic flag is not a verdict.
  const exclusions = new Set(excludedSources);
  const retainedBefore = before.map((row) => ({
    ...row,
    sources: Object.fromEntries(Object.entries(row.sources).filter(([source]) => !exclusions.has(`${row.date}/${source}`)))
  }));
  const decreases = exactHistoricalDecreases(retainedBefore, after);
  if (!decreases.length) return;
  if (!correction || correction.confirmed !== true || !correction.reason?.trim()) {
    throw new Error(`Blocked exact historical regression:\n${decreases.join("\n")}\nUse --allow-decrease --confirm-correction --correction-reason TEXT only after reviewing the exact correction.`);
  }
}

export function importArguments(args) {
  const index = args.indexOf("--correction-reason");
  const reason = index === -1 ? null : args[index + 1];
  if (index !== -1 && (!reason || reason.startsWith("--"))) throw new Error("--correction-reason requires a nonempty reason");
  const correction = args.includes("--allow-decrease")
    ? { confirmed: args.includes("--confirm-correction"), reason } : null;
  if (correction && (!correction.confirmed || !reason?.trim())) throw new Error("--allow-decrease requires --confirm-correction and --correction-reason after human review");
  return { correction, files: args.filter((arg, i) => !arg.startsWith("--") && (index === -1 || i !== index + 1)) };
}

// Every exact entry that a candidate dataset would lower, drop, or downgrade
// relative to the committed one. Shared by the importer gate and the weekly
// preparation check; lives here so the importer has no dependency on the
// personal release lane.
export const exactHistoricalDecreases = (before, after) => {
  const afterByDate = new Map(after.map((row) => [row.date, row]));
  const decreases = [];
  for (const priorRow of before) {
    const nextRow = afterByDate.get(priorRow.date);
    for (const [source, prior] of Object.entries(priorRow.sources ?? {})) {
      if (prior.fidelity !== "exact") continue;
      const next = nextRow?.sources?.[source];
      if (!next) {
        decreases.push(`${priorRow.date}/${source}: exact entry disappeared`);
      } else if (next.fidelity !== "exact") {
        decreases.push(`${priorRow.date}/${source}: fidelity exact -> ${next.fidelity ?? "missing"}`);
      } else if (next.tokens < prior.tokens) {
        decreases.push(`${priorRow.date}/${source}: tokens ${prior.tokens} -> ${next.tokens}`);
      } else if (prior.calls != null && (next.calls ?? -1) < prior.calls) {
        decreases.push(`${priorRow.date}/${source}: calls ${prior.calls} -> ${next.calls ?? "missing"}`);
      }
    }
  }
  return decreases;
};
