/**
 * Errors Tollgate raises.
 *
 * Every one carries a machine-readable `code`, because the layer above this is
 * usually an HTTP handler that has to choose a status, and matching on message
 * text is how that goes wrong quietly.
 */

export type TollgateErrorCode =
  /** The client sent something that cannot be a purchase. */
  | 'invalid_request'
  /** The store says this proof of purchase is not valid. */
  | 'invalid_purchase'
  /** The store issued it, but for a different app or account. */
  | 'not_yours'
  /** A sandbox purchase where sandbox purchases are not accepted. */
  | 'sandbox_rejected'
  /** The SKU is real but nothing in `store_products` maps it to a product. */
  | 'unmapped_product'
  /** A notification's signature did not verify. */
  | 'bad_signature'
  /** No adapter is configured for the store being asked about. */
  | 'unknown_store'
  /** The store could not be reached or answered with an error. */
  | 'store_unavailable'
  /** The database refused or could not be reached. */
  | 'persistence_failed';

export class TollgateError extends Error {
  readonly code: TollgateErrorCode;
  override readonly cause?: unknown;

  constructor(code: TollgateErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'TollgateError';
    this.code = code;
    this.cause = cause;
  }

  /**
   * Whether retrying the identical call could plausibly succeed.
   *
   * Handlers use this to decide between a 4xx, which tells a store to stop
   * redelivering, and a 5xx, which asks it to try again. Getting that backwards
   * either drops a purchase or invites an infinite redelivery loop.
   */
  get retryable(): boolean {
    return this.code === 'store_unavailable' ||
      this.code === 'persistence_failed';
  }

  static invalidRequest(message: string): TollgateError {
    return new TollgateError('invalid_request', message);
  }

  static unknownStore(store: string): TollgateError {
    return new TollgateError(
      'unknown_store',
      `No adapter is configured for the "${store}" store.`,
    );
  }
}
