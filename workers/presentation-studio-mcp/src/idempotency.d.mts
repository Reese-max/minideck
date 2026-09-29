export declare function stableStringify(value: unknown): string;

export declare function runIdempotent<AuthorizedContext, Result>(
  db: D1Database,
  ownerId: string,
  toolName: string,
  idempotencyKey: string | undefined,
  input: unknown,
  authorize: () => AuthorizedContext | Promise<AuthorizedContext>,
  action: (authorizedContext: AuthorizedContext) => Promise<Result>,
): Promise<Result>;

