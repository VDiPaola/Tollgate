/**
 * Drop-in edge function handlers.
 *
 * Two endpoints, with opposite threat models. The client one is called by a
 * signed-in user and trusts nothing they send beyond their identity. The
 * notification one is called by a store, is unauthenticated as far as Supabase
 * is concerned, and trusts nothing at all until the adapter has verified the
 * signature.
 */

import type { StoreId, Tollgate } from '@tollgate/core';
import { TollgateError } from '@tollgate/core';
import type { SupabaseClient } from '@supabase/supabase-js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

/** HTTP status for a Tollgate error, chosen so stores retry the right things. */
function statusFor(e: TollgateError): number {
  switch (e.code) {
    case 'bad_signature':
      return 401;
    case 'not_yours':
      return 403;
    case 'invalid_request':
    case 'invalid_purchase':
    case 'unmapped_product':
    case 'unknown_store':
      return 400;
    case 'sandbox_rejected':
      return 409;
    case 'store_unavailable':
    case 'persistence_failed':
      return 503;
    default:
      return 500;
  }
}

export interface ClientHandlerOptions {
  tollgate: Tollgate;
  /** Anon-key client, used only to turn the caller's JWT into a user id. */
  authClient: (authHeader: string) => SupabaseClient;
}

/**
 * The endpoint the app calls.
 *
 *   { action: "customer" }      -> the app account token to attach to purchases
 *   { action: "verify", ... }   -> check a purchase with its store and record it
 *   { action: "refresh" }       -> re-read everything, for "restore purchases"
 *   { action: "entitlements" }  -> what they have now
 *
 * The user id comes from the caller's JWT and never from the body. That is the
 * only thing standing between a signed-in user and granting themselves
 * somebody else's subscription.
 */
export function createClientHandler(
  opts: ClientHandlerOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

    try {
      const auth = req.headers.get('Authorization') ?? '';
      const { data } = await opts.authClient(auth).auth.getUser();
      const user = data.user;
      if (!user) return json({ error: 'Sign in first.' }, 401);

      const body = await req.json().catch(() => ({})) as {
        action?: string;
        store?: StoreId;
        token?: string;
        storeProductId?: string;
        variantId?: string;
        key?: string;
        kind?: 'subscription' | 'consumable' | 'non_consumable';
        /**
         * The device will acknowledge or consume this itself once it sees the
         * response. Both sides doing it is not harmless: Play errors on a
         * second consume, and a client SDK that did not do its own consume
         * cannot clear the purchase and re-delivers it on every app start.
         */
        completeOnDevice?: boolean;
      };

      switch (body.action) {
        case 'customer': {
          const info = await opts.tollgate.customer(user.id);
          // Entitlements go out as an array, not the map core holds them in.
          // Every other response here sends an array, and a client that has to
          // branch on the shape depending on which call produced it will get it
          // wrong exactly once, in the path that decides whether somebody has
          // paid.
          return json({
            ...info,
            entitlements: Object.values(info.entitlements),
          });
        }

        case 'products': {
          // Which SKU each product is sold under, so an app never has to
          // compile a store's ids into itself.
          const store = body.store;
          if (!store) return json({ error: 'Which store?' }, 400);
          return json({ products: await opts.tollgate.storeProducts(store) });
        }

        case 'entitlements':
          return json({
            entitlements: await opts.tollgate.entitlements(user.id),
          });

        case 'manage': {
          // Where to send somebody who wants to cancel. Null means the store
          // has no such page and the app should cancel through its own server
          // instead, which is how Stripe works and how neither mobile store
          // does: an in-app subscription cannot be cancelled from inside an
          // app at all, by either store's rules.
          const key = body.key ?? 'premium';
          return json({ url: await opts.tollgate.manageUrl(user.id, key) });
        }

        case 'refresh':
          return json({ entitlements: await opts.tollgate.refresh(user.id) });

        case 'verify': {
          if (!body.store || !body.token) {
            return json({ error: 'Which store, and which purchase?' }, 400);
          }
          const result = await opts.tollgate.purchase(
            body.store,
            {
              token: body.token,
              userId: user.id,
              storeProductId: body.storeProductId,
              basePlanId: body.variantId,
              kind: body.kind,
            },
            { settle: !body.completeOnDevice },
          );
          return json({
            entitlements: result.entitlements,
            granted: result.granted,
            delivered: result.delivered,
            grantResult: result.grantResult,
          });
        }

        default:
          return json({ error: `Unknown action "${body.action}".` }, 400);
      }
    } catch (e) {
      if (e instanceof TollgateError) {
        // Logged in full, returned as a sentence. Store errors quote request
        // ids and account details, and this is the one endpoint whose error
        // path stands next to somebody's money.
        console.error(`${e.code}: ${e.message}`, e.cause);
        return json({ error: e.message, code: e.code }, statusFor(e));
      }
      console.error(e);
      return json({ error: 'Could not complete that. Try again.' }, 500);
    }
  };
}

/**
 * The endpoint a store calls.
 *
 * Deploy with JWT verification disabled, because the caller is Google or Apple
 * and has no Supabase token. The adapter's signature check is what makes that
 * safe, and it is the only thing that does.
 *
 * The status code is a instruction to the store. A 2xx means "do not send this
 * again", so anything safely ignorable is answered 200 and only a genuine
 * inability to do the work returns 5xx, which asks for a redelivery.
 */
export function createNotificationHandler(
  tollgate: Tollgate,
  store: StoreId,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

    try {
      const result = await tollgate.handleNotification(store, req);
      return json(result);
    } catch (e) {
      if (e instanceof TollgateError) {
        console.error(`${store} notification ${e.code}: ${e.message}`, e.cause);
        // A bad signature must not ask for a retry: it did not come from the
        // store, so the store retrying changes nothing.
        return json(
          { error: e.message, code: e.code },
          e.retryable ? 503 : statusFor(e),
        );
      }
      console.error(e);
      return json({ error: 'Could not handle that notification.' }, 500);
    }
  };
}
