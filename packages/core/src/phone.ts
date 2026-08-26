/**
 * Indonesian numbers arrive as 0812…, 62812…, +62 812-…, or with stray spaces.
 * Everything is normalised to E.164 before it is hashed into a blind index —
 * otherwise the same customer becomes three contacts.
 */
export function normalisePhone(input: string, defaultCountry = '62'): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  if (!digits) return null;

  let n = digits.startsWith('+') ? digits.slice(1) : digits;
  if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('0')) n = defaultCountry + n.slice(1);
  else if (!n.startsWith(defaultCountry) && n.length <= 11) n = defaultCountry + n;

  if (!/^\d{8,15}$/.test(n)) return null;
  return `+${n}`;
}

/** For display in the console: +6281234567890 → +62 812-3456-7890 */
export function formatPhoneId(e164: string): string {
  const m = /^\+62(\d{3})(\d{3,4})(\d{3,5})$/.exec(e164);
  return m ? `+62 ${m[1]}-${m[2]}-${m[3]}` : e164;
}

/**
 * What an agent sees before they are entitled to reveal the full number.
 * Country code and last three digits only — enough to confirm you are looking at
 * the right customer, not enough to take the list home.
 */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '•'.repeat(e164.length);
  return `${e164.slice(0, 3)}${'•'.repeat(e164.length - 6)}${e164.slice(-3)}`;
}
