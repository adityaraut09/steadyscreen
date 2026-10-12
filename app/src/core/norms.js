// CDC STEADI 30-Second Chair Stand "Below Average Scores" table (CDC 2017 assessment form, page 1).
// A score BELOW the listed value is "below average", which the form says "indicates a risk for falls".
// The table covers ages 60-94 only. Nothing is extrapolated outside it, and age/sex are NEVER inferred
// from video: they must be entered by the observer.
export const CDC_30S_BELOW_AVERAGE = Object.freeze([
  { min: 60, max: 64, men: 14, women: 12 },
  { min: 65, max: 69, men: 12, women: 11 },
  { min: 70, max: 74, men: 12, women: 10 },
  { min: 75, max: 79, men: 11, women: 10 },
  { min: 80, max: 84, men: 10, women: 9 },
  { min: 85, max: 89, men: 8, women: 8 },
  { min: 90, max: 94, men: 7, women: 4 },
]);

/**
 * @param count   final chair-stand number (must come from a measured or observer-reviewed result)
 * @param age     observer-entered integer age, or null
 * @param sex     'men' | 'women' | null (the CDC table's categories)
 * @returns {applies:boolean, reason?:string, belowAverage?:boolean, threshold?:number, band?:string}
 */
export function cdcReference(count, age, sex) {
  if (count === null || count === undefined || !Number.isInteger(count)) return { applies: false, reason: "no valid count" };
  if (age === null || age === undefined || !Number.isInteger(age)) return { applies: false, reason: "age not entered" };
  if (sex !== "men" && sex !== "women") return { applies: false, reason: "sex not entered (table lists men / women)" };
  const row = CDC_30S_BELOW_AVERAGE.find((r) => age >= r.min && age <= r.max);
  if (!row) return { applies: false, reason: `the CDC table covers ages 60-94 only (entered age ${age})` };
  const threshold = row[sex];
  return { applies: true, belowAverage: count < threshold, threshold, band: `${row.min}-${row.max}, ${sex}` };
}
