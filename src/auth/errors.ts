/**
 * Auth-layer error taxonomy. Kept separate so any module can `throw new
 * NotAuthenticatedError()` without dragging in the rest of the auth stack.
 */

export class NotAuthenticatedError extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

export class TokenExpiredError extends Error {
  constructor(message = "Device code expired before approval") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

export class DeviceDeniedError extends Error {
  constructor(message = "Device authorization denied by user") {
    super(message);
    this.name = "DeviceDeniedError";
  }
}
