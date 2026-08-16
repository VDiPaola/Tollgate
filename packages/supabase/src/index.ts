/**
 * Tollgate on Supabase.
 *
 * The SQL pack lives in `../migrations`; copy both files into your project's
 * migrations directory with your own timestamp prefixes, keeping their order.
 * Then expose the schema to PostgREST (`[api] schemas = ["public", "tollgate"]`)
 * and point `tollgate.config` at your grant and revoke hooks.
 */

export { SupabasePersistence } from './persistence.ts';
export type { SupabasePersistenceOptions } from './persistence.ts';
