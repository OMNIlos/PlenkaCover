/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}
