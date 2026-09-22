import { validateLabelProvenance } from "./driver-evidence.js";

const SOURCE_PATTERN = /^[a-z0-9_]+$/;
const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

export const REVIEWED_DRIVERS = new Set([
  "building:feature",
  "building:content",
  "building:spec",
  "building:infra",
  "fixing:bug",
  "fixing:pipeline",
  "fixing:data",
  "fixing:security",
  "maintenance:docs",
  "maintenance:sync",
  "maintenance:hygiene",
  "maintenance:deps",
  "shipping",
  "writing",
  "strategy",
  "research",
  "career",
  "mixed",
  "unknown"
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

const isCalendarDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
};

const addCounter = (left, right, errors, label) => {
  const total = left + right;
  if (!Number.isSafeInteger(total)) errors.push(`${label} exceeds the safe integer range`);
  return total;
};

export function validateDataset(rows, options = {}) {
  const {
    timezone,
    windowStart,
    today,
    requireReviewed = false,
    allowSample = false
  } = options;
  const errors = [];

  if (!Array.isArray(rows)) return ["dataset must be an array"];
  if (timezone !== undefined && (typeof timezone !== "string" || !timezone)) {
    errors.push("validation timezone must be a nonempty string");
  }
  if (windowStart !== undefined && !isCalendarDate(windowStart)) {
    errors.push(`validation windowStart must be a calendar date, got ${String(windowStart)}`);
  }
  if (today !== undefined && !isCalendarDate(today)) {
    errors.push(`validation today must be a calendar date, got ${String(today)}`);
  }

  const seenDates = new Set();
  let previousDate = null;
  rows.forEach((row, index) => {
    const position = `row ${index + 1}`;
    if (!isRecord(row)) {
      errors.push(`${position} must be an object`);
      return;
    }
    for (const field of ["date", "timezone", "sources", "total", "driver"]) {
      if (!Object.hasOwn(row, field)) errors.push(`${position} missing ${field}`);
    }

    const date = row.date;
    if (Object.hasOwn(row, "label_provenance")) {
      for (const error of validateLabelProvenance(row.label_provenance, row.driver)) {
        errors.push(`${position}: ${error}`);
      }
    }
    const label = isCalendarDate(date) ? date : position;
    if (!isCalendarDate(date)) {
      errors.push(`${position} has invalid calendar date ${String(date)}`);
    } else {
      if (seenDates.has(date)) errors.push(`${date} appears more than once`);
      if (previousDate !== null && date <= previousDate) {
        errors.push(`${date} is not sorted after ${previousDate}`);
      }
      if (windowStart !== undefined && isCalendarDate(windowStart) && date < windowStart) {
        errors.push(`${date} precedes window start ${windowStart}`);
      }
      if (today !== undefined && isCalendarDate(today) && date >= today) {
        errors.push(`${date} is not a complete day before ${today}`);
      }
      seenDates.add(date);
      previousDate = date;
    }

    if (typeof row.timezone !== "string" || !row.timezone) {
      errors.push(`${label} timezone must be a nonempty string`);
    } else if (timezone !== undefined && typeof timezone === "string" && row.timezone !== timezone) {
      errors.push(`${label} timezone must be ${timezone}`);
    }

    let sourceSum = 0;
    if (!isRecord(row.sources) || Object.keys(row.sources).length === 0) {
      errors.push(`${label} sources must be a nonempty object`);
    } else {
      for (const [source, entry] of Object.entries(row.sources)) {
        if (!SOURCE_PATTERN.test(source)) {
          errors.push(`${label} source ${source} must use lowercase snake_case`);
        }
        if (!isRecord(entry)) {
          errors.push(`${label} source ${source} must be an object`);
          continue;
        }
        if (!isCounter(entry.tokens)) {
          errors.push(`${label} source ${source} tokens must be a nonnegative safe integer`);
        } else {
          sourceSum = addCounter(sourceSum, entry.tokens, errors, `${label} source sum`);
        }
        const fidelities = allowSample ? ["exact", "estimated", "sample"] : ["exact", "estimated"];
        if (!fidelities.includes(entry.fidelity)) {
          errors.push(
            `${label} source ${source} fidelity must be ${fidelities.join(", ")}`
          );
        }
        if (Object.hasOwn(entry, "calls") && !isCounter(entry.calls)) {
          errors.push(`${label} source ${source} calls must be a nonnegative safe integer`);
        }
        if (Object.hasOwn(entry, "by_origin")) {
          if (!isRecord(entry.by_origin)) {
            errors.push(`${label} source ${source} by_origin must be an object`);
          } else {
            let originSum = 0;
            for (const [origin, tokens] of Object.entries(entry.by_origin)) {
              if (!ORIGIN_PATTERN.test(origin)) {
                errors.push(`${label} source ${source} origin "${origin}" is malformed`);
              }
              if (!isCounter(tokens)) {
                errors.push(
                  `${label} source ${source} origin ${origin} tokens must be a nonnegative safe integer`
                );
              } else {
                originSum = addCounter(
                  originSum,
                  tokens,
                  errors,
                  `${label} source ${source} by_origin sum`
                );
              }
            }
            if (isCounter(entry.tokens) && originSum !== entry.tokens) {
              errors.push(
                `${label} source ${source} by_origin sums to ${originSum}, expected ${entry.tokens}`
              );
            }
          }
        }
      }
    }

    if (!isCounter(row.total)) {
      errors.push(`${label} total must be a nonnegative safe integer`);
    } else {
      if (row.total === 0) errors.push(`${label} total must be positive; unknown days must be absent`);
      if (row.total !== sourceSum) {
        errors.push(`${label} total ${row.total} does not equal source sum ${sourceSum}`);
      }
    }

    const validDrivers = requireReviewed
      ? REVIEWED_DRIVERS
      : new Set([...REVIEWED_DRIVERS, "unreviewed"]);
    if (!validDrivers.has(row.driver)) {
      errors.push(
        requireReviewed && row.driver === "unreviewed"
          ? `${label} driver must be reviewed before publication`
          : `${label} driver ${JSON.stringify(row.driver)} is not in the allowed vocabulary`
      );
    }
  });

  return errors;
}

export function assertDataset(rows, options = {}) {
  const errors = validateDataset(rows, options);
  if (!errors.length) return rows;
  const limit = 12;
  const shown = errors.slice(0, limit);
  const remainder = errors.length - shown.length;
  throw new Error(
    `Dataset validation failed:\n${shown.join("\n")}${remainder ? `\n...and ${remainder} more` : ""}`
  );
}

export { isCalendarDate };
