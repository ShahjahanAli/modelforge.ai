export interface PiiFinding {
  ruleId: string;
  count: number;
}

export interface PiiRedactionResult {
  text: string;
  findings: PiiFinding[];
}

export type PiiResult = PiiRedactionResult;

export interface PiiProvider {
  redact(text: string): PiiRedactionResult;
}

const RULES: Array<{ ruleId: string; pattern: RegExp; replacement: string }> = [
  {
    ruleId: "credit_card",
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    replacement: "[REDACTED_CREDIT_CARD]",
  },
  {
    ruleId: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    ruleId: "phone",
    pattern: /(?<![\w+])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d(?:[ .-]?\d){6,11}(?!\w)/g,
    replacement: "[REDACTED_PHONE]",
  },
];

export class LocalPiiProvider implements PiiProvider {
  redact(text: string): PiiRedactionResult {
    let output = text;
    const findings: PiiFinding[] = [];
    for (const rule of RULES) {
      const matches = output.match(rule.pattern);
      if (!matches?.length) continue;
      findings.push({ ruleId: rule.ruleId, count: matches.length });
      output = output.replace(rule.pattern, rule.replacement);
    }
    return { text: output, findings };
  }
}
