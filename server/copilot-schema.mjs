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

export function validateReferences(result, catalog) {
  const errors = [];
  const names = {
    batch: catalog.batches,
    teacher: catalog.teachers,
    subject: catalog.subjects,
    room: catalog.rooms,
  };
  const rules = result.rules.map((rule, index) => {
    let validation = rule.validation;
    let clarification = rule.clarification;
    if (rule.type === "unsupported") {
      validation = "unsupported";
      clarification ||= "This request is outside the scheduling rules supported by Schedulify.";
    }
    for (const [field, values] of Object.entries(names)) {
      if (rule[field] && !values.some((value) => value.toLowerCase() === rule[field].toLowerCase())) {
        validation = "needs_clarification";
        clarification = `“${rule[field]}” is not in the current ${field} list. Check the name or add it in Admin.`;
        errors.push(`Rule ${index + 1}: unknown ${field} “${rule[field]}”.`);
      }
    }
    return { ...rule, validation, clarification };
  });
  return { result: { ...result, rules }, errors };
}
