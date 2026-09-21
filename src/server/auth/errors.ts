export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 400 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
