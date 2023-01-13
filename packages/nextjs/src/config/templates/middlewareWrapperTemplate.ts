/**
 * This file is a template for the code which will be substituted when our webpack loader handles API files in the
 * `pages/` directory.
 *
 * We use `__RESOURCE_PATH__` as a placeholder for the path to the file being wrapped. Because it's not a real package,
 * this causes both TS and ESLint to complain, hence the pragma comments below.
 */

// @ts-ignore See above
// eslint-disable-next-line import/no-unresolved
import * as origModule from '__SENTRY_WRAPPING_TARGET__';
// eslint-disable-next-line import/no-extraneous-dependencies
import * as Sentry from '@sentry/nextjs';

// We import this from `wrappers` rather than directly from `next` because our version can work simultaneously with
// multiple versions of next. See note in `wrappers/types` for more.
import type { NextApiHandler } from '../../server/types';

type NextApiModule =
  | {
      // ESM export
      default?: NextApiHandler; // TODO CHANGE THIS TYPE
      middleware?: NextApiHandler; // TODO CHANGE THIS TYPE
    }
  // CJS export
  | NextApiHandler;

const userApiModule = origModule as NextApiModule;

// Default to undefined. It's possible for Next.js users to not define any exports/handlers in an API route. If that is
// the case Next.js wil crash during runtime but the Sentry SDK should definitely not crash so we need tohandle it.
let userProvidedNamedHandler: NextApiHandler | undefined = undefined;
let userProvidedDefaultHandler: NextApiHandler | undefined = undefined;

if ('middleware' in userApiModule && typeof userApiModule.middleware === 'function') {
  // Handle when user defines via named ESM export: `export { middleware };`
  userProvidedNamedHandler = userApiModule.middleware;
} else if ('default' in userApiModule && typeof userApiModule.default === 'function') {
  // Handle when user defines via ESM export: `export default myFunction;`
  userProvidedDefaultHandler = userApiModule.default;
} else if (typeof userApiModule === 'function') {
  // Handle when user defines via CJS export: "module.exports = myFunction;"
  userProvidedDefaultHandler = userApiModule;
}

export const middleware = userProvidedNamedHandler ? Sentry.withSentryMiddleware(userProvidedNamedHandler) : undefined;
export default userProvidedDefaultHandler ? Sentry.withSentryMiddleware(userProvidedDefaultHandler) : undefined;

// Re-export anything exported by the page module we're wrapping. When processing this code, Rollup is smart enough to
// not include anything whose name matchs something we've explicitly exported above.
// @ts-ignore See above
// eslint-disable-next-line import/no-unresolved
export * from '__SENTRY_WRAPPING_TARGET__';
