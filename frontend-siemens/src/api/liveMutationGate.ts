export class LiveMutationGate {
  private readonly pending = new Map<string, Promise<unknown>>();

  start<T>(key: string, mutation: () => Promise<T>): Promise<T> | null {
    if (this.pending.has(key)) return null;
    const request = mutation().finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
}
