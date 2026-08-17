/**
 * Tollgate core.
 *
 * One purchase API over several stores. Nothing here touches a database or a
 * network beyond the store adapters, and nothing here is specific to Supabase,
 * Deno or Node: it is `fetch` and Web Crypto only, so the same build runs in a
 * Supabase Edge Function and in a Next.js route handler.
 */

export * from './types.ts';
export * from './errors.ts';
export * from './adapter.ts';
export * from './persistence.ts';
export * from './tollgate.ts';
export { FakeStore } from './adapters/fake.ts';
export type { FakeNotification, SellOptions } from './adapters/fake.ts';

export { AppleAdapter } from './adapters/apple/adapter.ts';
export type { AppleAdapterOptions } from './adapters/apple/adapter.ts';
export { APPLE_ROOT_CA_G3_SPKI } from './adapters/apple/root.ts';
export {
  environmentOf as appleEnvironment,
  kindOf as appleProductKind,
  normalizeTransaction as normalizeAppleTransaction,
  offerTypeOf as appleOfferType,
  subscriptionStatus as appleSubscriptionStatus,
} from './adapters/apple/normalize.ts';
export {
  APPLE_SUBSCRIPTION_STATUS,
  REVOKING_NOTIFICATIONS as APPLE_REVOKING_NOTIFICATIONS,
  TRANSACTION_ID_NOT_FOUND as APPLE_TRANSACTION_ID_NOT_FOUND,
} from './adapters/apple/types.ts';
export type * from './adapters/apple/types.ts';

export { GoogleAdapter } from './adapters/google/adapter.ts';
export type { GoogleAdapterOptions } from './adapters/google/adapter.ts';
export { GoogleAuth, parseServiceAccount } from './adapters/google/auth.ts';
export type { ServiceAccount } from './adapters/google/auth.ts';
export {
  moneyToMicros,
  normalizeProduct as normalizeGoogleProduct,
  normalizeSubscription as normalizeGoogleSubscription,
  productStatus as googleProductStatus,
  subscriptionStatus as googleSubscriptionStatus,
} from './adapters/google/normalize.ts';
export type * from './adapters/google/types.ts';

export { StripeAdapter } from './adapters/stripe/adapter.ts';
export type { StripeAdapterOptions } from './adapters/stripe/adapter.ts';
export {
  normalizePaymentIntent as normalizeStripePaymentIntent,
  normalizeSubscription as normalizeStripeSubscription,
  subscriptionStatus as stripeSubscriptionStatus,
} from './adapters/stripe/normalize.ts';
export type * from './adapters/stripe/types.ts';

export {
  decodeJwt,
  signEs256,
  signRs256,
  verifyGoogleIdToken,
} from './crypto/jwt.ts';
export { verifyX5cJws } from './crypto/jws.ts';
export type { X5cJwsOptions } from './crypto/jws.ts';
export {
  importEcdsaKey,
  parseCertificate,
  verifyChain,
  verifySignedBy,
} from './crypto/x509.ts';
export { hmacSha256Hex, timingSafeEqual } from './crypto/hmac.ts';
export * from './crypto/encoding.ts';
