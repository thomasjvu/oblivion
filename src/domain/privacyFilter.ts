export const PRIVACY_MASK = "*******";

export function maskPrivacyText(text: string, terms: string[]): string {
  if (!text || !terms.length) return text;
  let out = text;
  const unique = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 2))];
  unique.sort((a, b) => b.length - a.length);
  for (const term of unique) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), PRIVACY_MASK);
  }
  return out;
}

export function expandNameTerms(label?: string, aliases: string[] = [], extra: string[] = []): string[] {
  const terms: string[] = [];
  const add = (value?: string) => {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2 && trimmed.toLowerCase() !== "private case") terms.push(trimmed);
  };
  add(label);
  aliases.forEach(add);
  extra.forEach(add);
  if (label) label.split(/\s+/).forEach(add);
  return terms;
}