export class InputError extends Error {
  override readonly name = "InputError";
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
