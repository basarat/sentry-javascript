import { Component } from '@angular/core';
import type { ActivatedRouteSnapshot, CanActivate, RouterStateSnapshot, Routes } from '@angular/router';
import { SEMANTIC_ATTRIBUTE_SENTRY_SOURCE } from '@sentry/core';

import { TraceClassDecorator, TraceDirective, TraceMethodDecorator, instrumentAngularRouting } from '../src';
import { getParameterizedRouteFromSnapshot } from '../src/tracing';
import { AppComponent, TestEnv } from './utils/index';

let transaction: any;

const defaultStartTransaction = (ctx: any) => {
  transaction = {
    ...ctx,
    updateName: jest.fn(name => (transaction.name = name)),
    setAttribute: jest.fn(),
    toJSON: () => ({
      data: {
        [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'custom',
        ...ctx.data,
        ...ctx.attributes,
      },
    }),
  };

  return transaction;
};

jest.mock('@sentry/browser', () => {
  const original = jest.requireActual('@sentry/browser');
  return {
    ...original,
    getCurrentScope() {
      return {
        getTransaction: () => {
          return transaction;
        },
      };
    },
  };
});

describe('Angular Tracing', () => {
  beforeEach(() => {
    transaction = undefined;
  });

  /* eslint-disable deprecation/deprecation */
  describe('instrumentAngularRouting', () => {
    it('should attach the transaction source on the pageload transaction', () => {
      const startTransaction = jest.fn();
      instrumentAngularRouting(startTransaction);

      expect(startTransaction).toHaveBeenCalledWith({
        name: '/',
        op: 'pageload',
        origin: 'auto.pageload.angular',
        attributes: { [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'url' },
      });
    });
  });
  /* eslint-enable deprecation/deprecation */

  describe('getParameterizedRouteFromSnapshot', () => {
    it.each([
      ['returns `/` if the route has no children', {}, '/'],
      [
        'returns `/` if the route has an empty child',
        {
          firstChild: { routeConfig: { path: '' } },
        },
        '/',
      ],
      [
        'returns the route of a snapshot without children',
        {
          firstChild: { routeConfig: { path: 'users/:id' } },
        },
        '/users/:id/',
      ],
      [
        'returns the complete route of a snapshot with children',
        {
          firstChild: {
            routeConfig: { path: 'orgs/:orgId' },
            firstChild: {
              routeConfig: { path: 'projects/:projId' },
              firstChild: { routeConfig: { path: 'overview' } },
            },
          },
        },
        '/orgs/:orgId/projects/:projId/overview/',
      ],
      [
        'returns the route of a snapshot without children but with empty paths',
        {
          firstChild: {
            routeConfig: { path: 'users' },
            firstChild: {
              routeConfig: { path: '' },
              firstChild: {
                routeConfig: { path: ':id' },
              },
            },
          },
        },
        '/users/:id/',
      ],
    ])('%s', (_: string, routeSnapshot: unknown, expectedParams: string) => {
      expect(getParameterizedRouteFromSnapshot(routeSnapshot as unknown as ActivatedRouteSnapshot)).toEqual(
        expectedParams,
      );
    });
  });

  describe('TraceService', () => {
    it('does not change the transaction name if the source is something other than `url`', async () => {
      const customStartTransaction = jest.fn((ctx: any) => {
        transaction = {
          ...ctx,
          toJSON: () => ({
            data: {
              ...ctx.data,
              [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'custom',
            },
          }),
          metadata: ctx.metadata,
          updateName: jest.fn(name => (transaction.name = name)),
          setAttribute: jest.fn(),
        };

        return transaction;
      });

      const env = await TestEnv.setup({
        customStartTransaction,
        routes: [
          {
            path: '',
            component: AppComponent,
          },
        ],
      });

      const url = '/';

      await env.navigateInAngular(url);

      expect(customStartTransaction).toHaveBeenCalledWith({
        name: url,
        op: 'pageload',
        origin: 'auto.pageload.angular',
        attributes: { [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'url' },
      });

      expect(transaction.updateName).toHaveBeenCalledTimes(0);
      expect(transaction.name).toEqual(url);
      expect(transaction.toJSON().data).toEqual({ [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'custom' });

      env.destroy();
    });

    it('re-assigns routing span on navigation start with active transaction.', async () => {
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        customStartTransaction,
      });

      const finishMock = jest.fn();
      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      await env.navigateInAngular('/');

      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });

    it('finishes routing span on navigation end', async () => {
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        customStartTransaction,
      });

      const finishMock = jest.fn();
      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      await env.navigateInAngular('/');

      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });

    it('finishes routing span on navigation error', async () => {
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        customStartTransaction,
        routes: [
          {
            path: '',
            component: AppComponent,
          },
        ],
        useTraceService: true,
      });

      const finishMock = jest.fn();
      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      await env.navigateInAngular('/somewhere');

      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });

    it('finishes routing span on navigation cancel', async () => {
      const customStartTransaction = jest.fn(defaultStartTransaction);

      class CanActivateGuard implements CanActivate {
        canActivate(_route: ActivatedRouteSnapshot, _state: RouterStateSnapshot): boolean {
          return false;
        }
      }

      const env = await TestEnv.setup({
        customStartTransaction,
        routes: [
          {
            path: 'cancel',
            component: AppComponent,
            canActivate: [CanActivateGuard],
          },
        ],
        useTraceService: true,
        additionalProviders: [{ provide: CanActivateGuard, useClass: CanActivateGuard }],
      });

      const finishMock = jest.fn();
      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      await env.navigateInAngular('/cancel');

      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });

    describe('URL parameterization', () => {
      it.each([
        [
          'handles the root URL correctly',
          '/',
          '/',
          [
            {
              path: '',
              component: AppComponent,
            },
          ],
        ],
        [
          'does not alter static routes',
          '/books',
          '/books/',
          [
            {
              path: 'books',
              component: AppComponent,
            },
          ],
        ],
        [
          'parameterizes IDs in the URL',
          '/books/1/details',
          '/books/:bookId/details/',
          [
            {
              path: 'books/:bookId/details',
              component: AppComponent,
            },
          ],
        ],
        [
          'parameterizes multiple IDs in the URL',
          '/org/sentry/projects/1234/events/04bc6846-4a1e-4af5-984a-003258f33e31',
          '/org/:orgId/projects/:projId/events/:eventId/',
          [
            {
              path: 'org/:orgId/projects/:projId/events/:eventId',
              component: AppComponent,
            },
          ],
        ],
        [
          'parameterizes URLs from route with child routes',
          '/org/sentry/projects/1234/events/04bc6846-4a1e-4af5-984a-003258f33e31',
          '/org/:orgId/projects/:projId/events/:eventId/',
          [
            {
              path: 'org/:orgId',
              component: AppComponent,
              children: [
                {
                  path: 'projects/:projId',
                  component: AppComponent,
                  children: [
                    {
                      path: 'events/:eventId',
                      component: AppComponent,
                    },
                  ],
                },
              ],
            },
          ],
        ],
      ])('%s and sets the source to `route`', async (_: string, url: string, result: string, routes: Routes) => {
        const customStartTransaction = jest.fn(defaultStartTransaction);
        const env = await TestEnv.setup({
          customStartTransaction,
          routes,
          startTransactionOnPageLoad: false,
        });

        await env.navigateInAngular(url);

        expect(customStartTransaction).toHaveBeenCalledWith({
          name: url,
          op: 'navigation',
          origin: 'auto.navigation.angular',
          attributes: { [SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'url' },
        });
        expect(transaction.updateName).toHaveBeenCalledWith(result);
        expect(transaction.setAttribute).toHaveBeenCalledWith(SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, 'route');

        env.destroy();
      });
    });
  });

  describe('TraceDirective', () => {
    it('should create an instance', () => {
      const directive = new TraceDirective();
      expect(directive).toBeTruthy();
    });

    it('should create a child tracingSpan on init', async () => {
      const directive = new TraceDirective();
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        components: [TraceDirective],
        customStartTransaction,
        useTraceService: false,
      });

      transaction.startChild = jest.fn();

      directive.ngOnInit();

      expect(transaction.startChild).toHaveBeenCalledWith({
        op: 'ui.angular.init',
        origin: 'auto.ui.angular.trace_directive',
        name: '<unknown>',
      });

      env.destroy();
    });

    it('should use component name as span name', async () => {
      const directive = new TraceDirective();
      const finishMock = jest.fn();
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        components: [TraceDirective],
        customStartTransaction,
        useTraceService: false,
      });

      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      directive.componentName = 'test-component';
      directive.ngOnInit();

      expect(transaction.startChild).toHaveBeenCalledWith({
        op: 'ui.angular.init',
        origin: 'auto.ui.angular.trace_directive',
        name: '<test-component>',
      });

      env.destroy();
    });

    it('should finish tracingSpan after view init', async () => {
      const directive = new TraceDirective();
      const finishMock = jest.fn();
      const customStartTransaction = jest.fn(defaultStartTransaction);

      const env = await TestEnv.setup({
        components: [TraceDirective],
        customStartTransaction,
        useTraceService: false,
      });

      transaction.startChild = jest.fn(() => ({
        end: finishMock,
      }));

      directive.ngOnInit();
      directive.ngAfterViewInit();

      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });
  });

  describe('TraceClassDecorator', () => {
    const origNgOnInitMock = jest.fn();
    const origNgAfterViewInitMock = jest.fn();

    @Component({
      selector: 'layout-header',
      template: '<router-outlet></router-outlet>',
    })
    @TraceClassDecorator()
    class DecoratedComponent {
      public ngOnInit() {
        origNgOnInitMock();
      }

      public ngAfterViewInit() {
        origNgAfterViewInitMock();
      }
    }

    it('Instruments `ngOnInit` and `ngAfterViewInit` methods of the decorated class', async () => {
      const finishMock = jest.fn();
      const startChildMock = jest.fn(() => ({
        end: finishMock,
      }));

      const customStartTransaction = jest.fn((ctx: any) => {
        transaction = {
          ...ctx,
          startChild: startChildMock,
        };

        return transaction;
      });

      const env = await TestEnv.setup({
        customStartTransaction,
        components: [DecoratedComponent],
        defaultComponent: DecoratedComponent,
        useTraceService: false,
      });

      expect(transaction.startChild).toHaveBeenCalledWith({
        name: '<DecoratedComponent>',
        op: 'ui.angular.init',
        origin: 'auto.ui.angular.trace_class_decorator',
      });

      expect(origNgOnInitMock).toHaveBeenCalledTimes(1);
      expect(origNgAfterViewInitMock).toHaveBeenCalledTimes(1);
      expect(finishMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });
  });

  describe('TraceMethodDecorator', () => {
    const origNgOnInitMock = jest.fn();
    const origNgAfterViewInitMock = jest.fn();

    @Component({
      selector: 'layout-header',
      template: '<router-outlet></router-outlet>',
    })
    class DecoratedComponent {
      @TraceMethodDecorator()
      public ngOnInit() {
        origNgOnInitMock();
      }

      @TraceMethodDecorator()
      public ngAfterViewInit() {
        origNgAfterViewInitMock();
      }
    }

    it('Instruments `ngOnInit` and `ngAfterViewInit` methods of the decorated class', async () => {
      const startChildMock = jest.fn();

      const customStartTransaction = jest.fn((ctx: any) => {
        transaction = {
          ...ctx,
          startChild: startChildMock,
        };

        return transaction;
      });

      const env = await TestEnv.setup({
        customStartTransaction,
        components: [DecoratedComponent],
        defaultComponent: DecoratedComponent,
        useTraceService: false,
      });

      expect(transaction.startChild).toHaveBeenCalledTimes(2);
      expect(transaction.startChild.mock.calls[0][0]).toEqual({
        name: '<DecoratedComponent>',
        op: 'ui.angular.ngOnInit',
        origin: 'auto.ui.angular.trace_method_decorator',
        startTimestamp: expect.any(Number),
        endTimestamp: expect.any(Number),
      });

      expect(transaction.startChild.mock.calls[1][0]).toEqual({
        name: '<DecoratedComponent>',
        op: 'ui.angular.ngAfterViewInit',
        origin: 'auto.ui.angular.trace_method_decorator',
        startTimestamp: expect.any(Number),
        endTimestamp: expect.any(Number),
      });

      expect(origNgOnInitMock).toHaveBeenCalledTimes(1);
      expect(origNgAfterViewInitMock).toHaveBeenCalledTimes(1);

      env.destroy();
    });
  });
});
