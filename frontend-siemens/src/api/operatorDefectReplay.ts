import { isDeliveryUncertain } from './idempotentOperation';

export type OperatorDefectRetryComments = Readonly<Record<string, string>>;

export function operatorDefectIntent(rollCode: string): string {
  return `operator:${rollCode}:operator-defect`;
}

export function operatorDefectCommentForAttempt(
  retryComments: OperatorDefectRetryComments,
  intent: string,
  draftComment: string,
): string {
  return retryComments[intent] ?? draftComment.trim();
}

export function updateOperatorDefectRetry(
  retryComments: OperatorDefectRetryComments,
  intent: string,
  attemptedComment: string,
  error: unknown,
): OperatorDefectRetryComments {
  if (isDeliveryUncertain(error)) {
    if (retryComments[intent] === attemptedComment) return retryComments;
    return { ...retryComments, [intent]: attemptedComment };
  }
  return clearOperatorDefectRetry(retryComments, intent);
}

export function clearOperatorDefectRetry(
  retryComments: OperatorDefectRetryComments,
  intent: string,
): OperatorDefectRetryComments {
  if (!(intent in retryComments)) return retryComments;
  const next = { ...retryComments };
  delete next[intent];
  return next;
}
