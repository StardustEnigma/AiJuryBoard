export type PolicyCheck = {
  allowed: boolean;
  sanitizedText: string;
  warnings: string[];
  reason?: string;
};

const INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|prior)\s+instructions?/gi,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/gi,
  /jailbreak/gi,
  /developer\s+mode/gi,
  /do\s+anything\s+now/gi,
];

const SYNTHESIS_SECTION_LABELS = [
  'PROSECUTION_SUMMARY:',
  'DEFENSE_SUMMARY:',
  'DEVIL_ADVOCATE_ANALYSIS:',
  'SHARED_REALITY:',
  'REMAINING_DISAGREEMENT:',
  'VERDICT:',
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*•]\s+/gm, '')
    .trim();
}

function clampWords(value: string, maxWords: number): string {
  const words = normalizeWhitespace(value).split(' ').filter(Boolean);
  if (words.length <= maxWords) {
    return normalizeWhitespace(value);
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

function applyInjectionSanitization(value: string): { sanitized: string; warnings: string[] } {
  let sanitized = value;
  const warnings: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      warnings.push('prompt-injection-pattern-removed');
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, ' ');
    }
  }

  return {
    sanitized: normalizeWhitespace(sanitized),
    warnings,
  };
}

export function gateSearchTopic(topic: string): PolicyCheck {
  const trimmed = normalizeWhitespace(topic).slice(0, 300);
  if (!trimmed) {
    return {
      allowed: false,
      sanitizedText: '',
      warnings: ['empty-topic'],
      reason: 'Topic is empty after normalization',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(trimmed);
  if (!sanitized) {
    return {
      allowed: false,
      sanitizedText: '',
      warnings: [...warnings, 'topic-removed-by-policy'],
      reason: 'Topic content removed by policy sanitization',
    };
  }

  return {
    allowed: true,
    sanitizedText: sanitized,
    warnings,
  };
}

export function fallbackArgument(role: string): string {
  if (role === 'PROSECUTION') {
    return 'Point 1: The evidence suggests the core problem is serious and affects real people. Point 2: Multiple sources indicate harm grows when action is delayed. Point 3: A structured response with clear safeguards can reduce risk while staying accountable. Closing: Based on available facts, stronger but controlled action is justified.';
  }

  if (role === 'DEFENSE') {
    return 'Counterpoint 1: The issue is complex and cannot be explained by one cause alone. Counterpoint 2: Some evidence may be selective, so policy should be tested before wide rollout. Counterpoint 3: Fast interventions can create side effects and unfair outcomes if safeguards are weak. Closing: A phased, evidence-led approach is safer than one-sided conclusions.';
  }

  return 'Gap 1: Both sides use assumptions that are not fully stress-tested. Gap 2: Evidence strength differs across major claims. Gap 3: Long-term outcomes and implementation constraints remain uncertain. Question: What changes if the strongest assumption from each side fails in practice?';
}

export function gateGeneratedArgument(role: string, text: string, maxWords: number): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText: fallbackArgument(role),
      warnings: ['empty-generated-text'],
      reason: 'Model returned empty text',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(normalized);
  const limited = clampWords(sanitized, maxWords);

  const outputWarnings = [...warnings];
  if (limited !== sanitized) {
    outputWarnings.push('argument-trimmed-to-word-cap');
  }

  return {
    allowed: true,
    sanitizedText: limited,
    warnings: outputWarnings,
  };
}

function canonicalizeSynthesisSections(value: string, maxWordsPerSection = 18): string {
  const source = value.replace(/\r?\n/g, ' ');
  const tokenRegex =
    /(PROSECUTION_SUMMARY:|DEFENSE_SUMMARY:|DEVIL_ADVOCATE_ANALYSIS:|SHARED_REALITY:|REMAINING_DISAGREEMENT:|VERDICT:)/gi;

  const tokens: Array<{ label: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(source)) !== null) {
    tokens.push({
      label: match[1].toUpperCase(),
      start: match.index,
      end: tokenRegex.lastIndex,
    });
  }

  const collected = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    const raw = source.slice(current.end, next?.start ?? source.length);
    const normalized = normalizeWhitespace(raw);

    if (!normalized) {
      continue;
    }

    const existing = collected.get(current.label) ?? [];
    existing.push(normalized);
    collected.set(current.label, existing);
  }

  if (tokens.length === 0) {
    const fallback = clampWords(normalizeWhitespace(source), maxWordsPerSection) || 'Not provided.';
    return SYNTHESIS_SECTION_LABELS.map((label) =>
      label === 'VERDICT:' ? `${label} ${fallback}` : `${label} Not provided.`
    ).join('\n');
  }

  return SYNTHESIS_SECTION_LABELS.map((label) => {
    const candidates = collected.get(label) ?? [];
    const preferred =
      candidates.find((candidate) => !/^not provided\.?$/i.test(candidate)) ??
      candidates[0] ??
      'Not provided.';

    return `${label} ${clampWords(preferred, maxWordsPerSection)}`;
  }).join('\n');
}

function canonicalizeFallacyOutput(value: string): string {
  const source = value.replace(/\r?\n/g, ' ');
  const tokenRegex = /(FALLACIES:|SEVERITY:|EXPLANATION:)/gi;
  const tokens: Array<{ label: string; start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(source)) !== null) {
    tokens.push({
      label: match[1].toUpperCase(),
      start: match.index,
      end: tokenRegex.lastIndex,
    });
  }

  const sections = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    const content = normalizeWhitespace(source.slice(current.end, next?.start ?? source.length));
    if (!content) {
      continue;
    }

    const existing = sections.get(current.label) ?? [];
    existing.push(content);
    sections.set(current.label, existing);
  }

  const pick = (label: string, fallback: string) => {
    const values = sections.get(label) ?? [];
    const preferred = values.find((value) => !/^not provided\.?$/i.test(value));
    return preferred ?? values[0] ?? fallback;
  };

  const fallacies = pick('FALLACIES:', 'None');
  const severityRaw = pick('SEVERITY:', 'LOW').toUpperCase();
  const severityMatch = severityRaw.match(/CRITICAL|HIGH|MEDIUM|LOW|NONE/);
  const severity = severityMatch ? severityMatch[0] : 'LOW';
  const explanation = pick('EXPLANATION:', 'No analyzable output returned.');

  return `FALLACIES: ${fallacies}\nSEVERITY: ${severity}\nEXPLANATION: ${explanation}`;
}

export function gateSynthesisOutput(text: string, maxWords = 160): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText:
        [
          'PROSECUTION_SUMMARY: Not provided.',
          'DEFENSE_SUMMARY: Not provided.',
          'DEVIL_ADVOCATE_ANALYSIS: Not provided.',
          'SHARED_REALITY: Not provided.',
          'REMAINING_DISAGREEMENT: Not provided.',
          'VERDICT: Unable to determine due to insufficient synthesis output.',
        ].join('\n'),
      warnings: ['empty-synthesis-output'],
      reason: 'Model returned empty synthesis',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(stripped);
  const sectioned = canonicalizeSynthesisSections(sanitized, 18);
  const wordCount = normalizeWhitespace(sectioned).split(' ').filter(Boolean).length;
  const outputWarnings = [...warnings];

  if (wordCount > maxWords) {
    outputWarnings.push('synthesis-exceeds-word-cap');
  }

  return {
    allowed: true,
    sanitizedText: sectioned,
    warnings: outputWarnings,
  };
}

export function gateFallacyOutput(text: string): PolicyCheck {
  const stripped = stripMarkdown(text);
  const normalized = normalizeWhitespace(stripped);

  if (!normalized) {
    return {
      allowed: false,
      sanitizedText: 'FALLACIES: None\nSEVERITY: NONE\nEXPLANATION: No analyzable output returned.',
      warnings: ['empty-fallacy-output'],
      reason: 'Model returned empty fallacy analysis',
    };
  }

  const { sanitized, warnings } = applyInjectionSanitization(stripped);
  const ensuredStructured = canonicalizeFallacyOutput(sanitized);

  return {
    allowed: true,
    sanitizedText: ensuredStructured,
    warnings,
  };
}