function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Return the recorded fallback reason when generated scene content is degraded. */
export function getDegradedSceneContentIssue(content: unknown): string | null {
  if (!isRecord(content) || !isRecord(content.quality)) return null;
  if (content.quality.status !== 'degraded') return null;

  const issues = content.quality.issues;
  if (Array.isArray(issues)) {
    const issue = issues.find(
      (value): value is string => typeof value === 'string' && !!value.trim(),
    );
    if (issue) return issue.trim();
  }

  return 'generation used fallback content';
}
