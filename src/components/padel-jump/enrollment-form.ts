export type EnrollmentFields = { firstName: string; lastName: string; email: string; companyWebsite: string };
export function normalizeEnrollment(value: unknown): EnrollmentFields {
  const invalid = () => { throw new Error('ENROLLMENT_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(k => !['firstName', 'lastName', 'email', 'companyWebsite', 'consent'].includes(k)) || fields.consent !== true) return invalid();
  const text = (key: string, max: number) => {
    const raw = fields[key];
    if (typeof raw !== 'string' || /[\p{C}<>]/u.test(raw)) return invalid();
    const result = raw.trim().replace(/\s+/g, ' ');
    if (!result || result.length > max) return invalid();
    return result;
  };
  const firstName = text('firstName', 80), lastName = text('lastName', 80), email = text('email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid();
  const website = text('companyWebsite', 500);
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(website) ? website : 'https://' + website); } catch { return invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || url.href.length > 500) return invalid();
  return { firstName, lastName, email, companyWebsite: url.href };
}
