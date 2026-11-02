/** An error meant for the person or agent running hcoord: printed without a stack trace. */
export class HcoordError extends Error {
  constructor(
    message: string,
    /** Process exit code: 1 = failed, 2 = bad usage. */
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "HcoordError";
  }
}

export class UsageError extends HcoordError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
