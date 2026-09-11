// Pure formatting and clock arithmetic shared by the browser and regression tests.
export function formatTaskPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "待估算";
  const number = Number(value);
  if (number > 0 && number < 0.000001) return "<0.000001%";
  if (number > 0 && number < 1)
    return `${number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return `${number.toFixed(2)}%`;
}

export function resetDeadline(reset, snapshotNow) {
  if (reset?.stale) return null;
  if (reset?.scheduledAt !== null && reset?.scheduledAt !== undefined) {
    const timestamp = typeof reset.scheduledAt === "number"
      ? reset.scheduledAt : Date.parse(reset.scheduledAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.isFinite(reset?.secondsUntil) && Number.isFinite(snapshotNow)
    ? snapshotNow + reset.secondsUntil * 1000 : null;
}
