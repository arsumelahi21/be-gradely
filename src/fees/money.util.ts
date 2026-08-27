/**
 * Server-side money formatting — used only inside error messages, so an
 * "exceeds the remaining balance" rejection can name the actual figure.
 * Display formatting proper belongs on the frontend.
 */
export function formatMinorUnits(minor: number, currency = 'PKR'): string {
  const major = (Number(minor) || 0) / 100;
  return `${currency} ${major.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
