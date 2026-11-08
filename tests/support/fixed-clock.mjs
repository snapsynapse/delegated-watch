// Test-only clock shift, loaded with `node --import` by
// tests/weekday-matrix.test.js. It moves the wall clock forward by
// DELEGATED_WATCH_TEST_CLOCK_DAYS whole days in this process and, through
// NODE_OPTIONS, in every process it spawns, so the importer under test sees
// the same shifted day as the test that built its fixtures. Dates built from
// an explicit value are untouched. No production script imports this file.

const days = Number(process.env.DELEGATED_WATCH_TEST_CLOCK_DAYS);
if (!Number.isInteger(days) || days < 0 || days > 6) {
  throw new Error("DELEGATED_WATCH_TEST_CLOCK_DAYS must be a whole number from 0 to 6");
}
const offset = days * 24 * 60 * 60 * 1000;
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + offset);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate;
