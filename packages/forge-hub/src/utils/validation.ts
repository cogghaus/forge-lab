/**
 * Server-side logging shape for Zod validation failures (security finding 6).
 * Responses carry only a generic `invalid_input`; the detail goes to the log.
 * Allowlists path/code/message per issue so the raw submitted values that some
 * issue types carry (e.g. `received`) are not copied into logs wholesale.
 */
import type { ZodError } from 'zod';

export interface LoggedZodIssue {
  path: string;
  code: string;
  message: string;
}

export function summarizeZodIssues(error: ZodError): LoggedZodIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
