import { SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, startInactiveSpan } from '@sentry/core';
import type { SpanAttributes } from '@sentry/types';
import { fill, isThenable, loadModule, logger } from '@sentry/utils';

import { DEBUG_BUILD } from '../../common/debug-build';
import type { LazyLoadedIntegration } from './lazy';

type PgClientQuery = (
  config: unknown,
  values?: unknown,
  callback?: (err: unknown, result: unknown) => void,
) => void | Promise<unknown>;

interface PgClient {
  prototype: {
    query: PgClientQuery;
  };
}

interface PgClientThis {
  database?: string;
  host?: string;
  port?: number;
  user?: string;
}

interface PgOptions {
  usePgNative?: boolean;
  /**
   * Supply your postgres module directly, instead of having Sentry attempt automatic resolution.
   * Use this if you (a) use a module that's not `pg`, or (b) use a bundler that breaks resolution (e.g. esbuild).
   *
   * Usage:
   * ```
   * import pg from 'pg';
   *
   * Sentry.init({
   *   integrations: [new Sentry.Integrations.Postgres({ module: pg })],
   * });
   * ```
   */
  module?: PGModule;
}

type PGModule = { Client: PgClient; native: { Client: PgClient } | null };

/** Tracing integration for node-postgres package */
export class Postgres implements LazyLoadedIntegration<PGModule> {
  /**
   * @inheritDoc
   */
  public static id: string = 'Postgres';

  /**
   * @inheritDoc
   */
  public name: string;

  private _usePgNative: boolean;

  private _module?: PGModule;

  public constructor(options: PgOptions = {}) {
    this.name = Postgres.id;
    this._usePgNative = !!options.usePgNative;
    this._module = options.module;
  }

  /** @inheritdoc */
  public loadDependency(): PGModule | undefined {
    return (this._module = this._module || loadModule('pg'));
  }

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    const pkg = this.loadDependency();

    if (!pkg) {
      DEBUG_BUILD && logger.error('Postgres Integration was unable to require `pg` package.');
      return;
    }

    const Client = this._usePgNative ? pkg.native?.Client : pkg.Client;

    if (!Client) {
      DEBUG_BUILD && logger.error("Postgres Integration was unable to access 'pg-native' bindings.");
      return;
    }

    /**
     * function (query, callback) => void
     * function (query, params, callback) => void
     * function (query) => Promise
     * function (query, params) => Promise
     * function (pg.Cursor) => pg.Cursor
     */
    fill(Client.prototype, 'query', function (orig: PgClientQuery) {
      return function (this: PgClientThis, config: unknown, values: unknown, callback: unknown) {
        const attributes: SpanAttributes = {
          'db.system': 'postgresql',
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.db.postgres',
        };

        try {
          if (this.database) {
            attributes['db.name'] = this.database;
          }
          if (this.host) {
            attributes['server.address'] = this.host;
          }
          if (this.port) {
            attributes['server.port'] = this.port;
          }
          if (this.user) {
            attributes['db.user'] = this.user;
          }
        } catch (e) {
          // ignore
        }

        const span = startInactiveSpan({
          onlyIfParent: true,
          name: typeof config === 'string' ? config : (config as { text: string }).text,
          op: 'db',
          attributes,
        });

        if (typeof callback === 'function') {
          return orig.call(this, config, values, function (err: Error, result: unknown) {
            span?.end();
            callback(err, result);
          });
        }

        if (typeof values === 'function') {
          return orig.call(this, config, function (err: Error, result: unknown) {
            span?.end();
            values(err, result);
          });
        }

        const rv = typeof values !== 'undefined' ? orig.call(this, config, values) : orig.call(this, config);

        if (isThenable(rv)) {
          return rv.then((res: unknown) => {
            span?.end();
            return res;
          });
        }

        span?.end();
        return rv;
      };
    });
  }
}
