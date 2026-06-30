export type PromptSegment = {
  index: number;
  text: string;
};

export type SplitLongScriptOptions = {
  minChars?: number;
  maxChars?: number;
};

function normalizeCopy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitOversizedUnit(unit: string, maxChars: number) {
  if (unit.length <= maxChars) return [unit];
  const parts: string[] = [];
  for (let start = 0; start < unit.length; start += maxChars) {
    parts.push(unit.slice(start, start + maxChars).trim());
  }
  return parts.filter(Boolean);
}

function splitIntoRhythmUnits(script: string) {
  return normalizeCopy(script)
    .split(/(?<=[。！？!?；;])|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function splitLongScriptIntoPromptSegments(script: string, options: SplitLongScriptOptions = {}): PromptSegment[] {
  const normalized = normalizeCopy(script);
  if (!normalized) return [];

  const minChars = options.minChars ?? 260;
  const maxChars = options.maxChars ?? 820;
  const units = splitIntoRhythmUnits(normalized).flatMap((unit) => splitOversizedUnit(unit, maxChars));
  const segments: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}\n${unit}` : unit;
    if (current && candidate.length > maxChars && current.length >= minChars) {
      segments.push(current.trim());
      current = unit;
      continue;
    }

    if (current && candidate.length > maxChars) {
      segments.push(current.trim());
      current = unit;
      continue;
    }

    current = candidate;
  }

  if (current.trim()) segments.push(current.trim());

  return segments.map((text, index) => ({ index: index + 1, text }));
}
