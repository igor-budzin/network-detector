// Shown as the two largest units, e.g. "5 год 5 хв" or "2 дн 3 год", with a zero second unit left out.
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)} с`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours >= 24) return joinUnits(Math.floor(totalHours / 24), "дн", totalHours % 24, "год");
  if (totalHours > 0) return joinUnits(totalHours, "год", totalMinutes % 60, "хв");
  return `${totalMinutes} хв`;
}

function joinUnits(major: number, majorUnit: string, minor: number, minorUnit: string): string {
  return minor === 0 ? `${major} ${majorUnit}` : `${major} ${majorUnit} ${minor} ${minorUnit}`;
}

const PLURAL = new Intl.PluralRules("uk-UA");

// Ukrainian nouns take one of three forms after a number: 1 відключення, 2 відключення, 5 відключень.
export function plural(count: number, forms: { one: string; few: string; many: string }): string {
  const category = PLURAL.select(count);
  return category === "one" ? forms.one : category === "few" ? forms.few : forms.many;
}
