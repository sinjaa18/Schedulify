import { z } from "zod";

export const ruleSchema = z.object({
  type: z.enum(["keep_day_free", "prefer_subject_before_lunch", "avoid_teacher_consecutive", "unsupported"]),
  priority: z.enum(["hard", "soft"]),
  batch: z.string().nullable(),
  teacher: z.string().nullable(),
  subject: z.string().nullable(),
  room: z.string().nullable(),
  day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri"]).nullable(),
  period: z.enum(["morning", "afternoon"]).nullable(),
  explanation: z.string().min(1).max(500),
  validation: z.enum(["ready", "needs_clarification", "unsupported"]),
  clarification: z.string().max(300).nullable(),
}).strict();

export const interpretationSchema = z.object({
  summary: z.string().min(1).max(500),
  rules: z.array(ruleSchema).max(8),
  nextSteps: z.array(z.string().max(200)).max(4),
}).strict();

const wildcardReferenceValues = new Set([
  'any', 'all', 'all batches', 'all teachers', 'all subjects', 'all rooms',
  'any batch', 'any teacher', 'any subject', 'any room',
  'every batch', 'every teacher', 'every subject', 'every room',
  'everyone', 'everybody', 'all of them', 'all resources',
  'no preference', 'no specific batch', 'no specific teacher', 'no specific subject', 'no specific room',
  'none', 'null', 'n/a', '*',
]);

function normaliseReference(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const token = trimmed.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!token || wildcardReferenceValues.has(token)) return null;
  return trimmed;
}

export function validateReferences(result, catalog) {
  const errors = [];
  const names = {
    batch: catalog.batches,
    teacher: catalog.teachers,
    subject: catalog.subjects,
    room: catalog.rooms,
  };
  const rules = result.rules.map((rule, index) => {
    const normalisedRule = { ...rule };
    for (const field of Object.keys(names)) normalisedRule[field] = normaliseReference(rule[field]);
    let validation = normalisedRule.validation;
    let clarification = normalisedRule.clarification;
    if (normalisedRule.type === 'unsupported') {
      validation = 'unsupported';
      clarification ||= 'This request is outside the scheduling rules supported by Schedulify.';
    }
    for (const [field, values] of Object.entries(names)) {
      const reference = normalisedRule[field];
      if (reference && !values.some((value) => value.toLowerCase() === reference.toLowerCase())) {
        validation = 'needs_clarification';
        clarification = `â€œ${reference}â€ is not in the current ${field} list. Check the name or add it in Admin.`;
        errors.push(`Rule ${index + 1}: unknown ${field} â€œ${reference}â€.`);
      }
    }
    return { ...normalisedRule, validation, clarification };
  });
  return { result: { ...result, rules }, errors };
}