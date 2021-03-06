/* eslint-disable no-void */
import { CanonicalCode, context } from '@opentelemetry/api';
import { NoopLogger } from '@opentelemetry/core';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { NodeTracerProvider } from '@opentelemetry/node';
import { DatabaseAttribute } from '@opentelemetry/semantic-conventions';
import { InMemorySpanExporter, ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/tracing';
import knex from 'knex';
import shimmer from 'shimmer';
import { KnexPlugin, plugin } from '../lib';

function checkSpanAttributes(
    spans: Readonly<ReadableSpan[]>,
    name: string,
    code: CanonicalCode,
    stmt: string,
    err?: Error,
): void {
    expect(spans[0].name).toBe(name);
    expect(spans[0].status.code).toBe(code);
    expect(spans[0].attributes[DatabaseAttribute.DB_SYSTEM]).toBe('sqlite3');
    expect(spans[0].attributes[DatabaseAttribute.DB_NAME]).toBe(':memory:');
    expect(spans[0].attributes[DatabaseAttribute.DB_STATEMENT]).toBe(stmt);
    expect(spans[0].status.message).toBe(err?.message);
}

describe('KnexPlugin', () => {
    let contextManager: AsyncHooksContextManager;
    let connection: knex;
    const provider = new NodeTracerProvider({ plugins: {} });
    const logger = new NoopLogger();
    const memoryExporter = new InMemorySpanExporter();

    beforeAll(() => {
        provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    });

    afterAll(() => connection.destroy());

    beforeEach(() => {
        shimmer({
            logger: (msg) => {
                throw new Error(msg);
            },
        });

        contextManager = new AsyncHooksContextManager().enable();
        context.setGlobalContextManager(contextManager);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugin.enable(knex as any, provider, logger);

        connection = knex({
            client: 'sqlite',
            connection: {
                filename: ':memory:',
            },
            useNullAsDefault: true,
        });
    });

    afterEach(() => {
        jest.resetAllMocks();
        context.disable();
        memoryExporter.reset();
        plugin.disable();
    });

    it('should export a plugin', () => {
        expect(plugin).toBeInstanceOf(KnexPlugin);
    });

    it('should have correct moduleName', () => {
        expect(plugin.moduleName).toBe('knex');
    });

    it('should handle double enable() gracefully', () =>
        new Promise((done) => {
            const span = provider.getTracer('default').startSpan('test span');
            provider.getTracer('default').withSpan(span, () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                plugin.enable(knex as any, provider, logger);
                connection.select(connection.raw('2+2')).finally(() => {
                    const spans = memoryExporter.getFinishedSpans();
                    expect(spans).toHaveLength(1);
                    done();
                });
            });
        }));

    it('should handle double disable() gracefully', () =>
        new Promise((done) => {
            const span = provider.getTracer('default').startSpan('test span');
            provider.getTracer('default').withSpan(span, () => {
                plugin.disable();
                plugin.disable();

                connection.select(connection.raw('2+2')).finally(() => {
                    const spans = memoryExporter.getFinishedSpans();
                    expect(spans).toHaveLength(0);
                    done();
                });
            });
        }));

    it('should name the span accordingly', () =>
        new Promise((done) => {
            const span = provider.getTracer('default').startSpan('test span');
            provider.getTracer('default').withSpan(span, () => {
                connection.select(connection.raw('2+2')).finally(() => {
                    const spans = memoryExporter.getFinishedSpans();
                    expect(spans).toHaveLength(1);
                    checkSpanAttributes(spans, 'select', CanonicalCode.OK, 'select 2+2');
                    done();
                });
            });
        }));

    it('should add bindings to DB_STATEMENT', () =>
        new Promise((done) => {
            const span = provider.getTracer('default').startSpan('test span');
            provider.getTracer('default').withSpan(span, () => {
                connection.select(connection.raw('?', 2)).finally(() => {
                    const spans = memoryExporter.getFinishedSpans();
                    checkSpanAttributes(spans, 'select', CanonicalCode.OK, 'select ?\nwith [2]');
                    done();
                });
            });
        }));

    it('should attach error messages to spans', () =>
        new Promise((done) => {
            const span = provider.getTracer('default').startSpan('test span');
            provider.getTracer('default').withSpan(span, () => {
                connection.raw('SLECT 2+2').catch((e: Error) => {
                    const spans = memoryExporter.getFinishedSpans();
                    expect(spans).toHaveLength(1);
                    checkSpanAttributes(spans, 'raw', CanonicalCode.UNKNOWN, 'SLECT 2+2', e);
                    done();
                });
            });
        }));

    // See https://github.com/wdalmut/opentelemetry-plugin-mongoose/pull/34/files
    it('should handle await on a thenable query object (raw)', () => {
        const rootSpan = provider.getTracer('default').startSpan('test span');
        return provider.getTracer('default').withSpan(rootSpan, async () => {
            await connection.raw('SELECT 2+2');

            const spans = memoryExporter.getFinishedSpans();
            expect(spans).toHaveLength(1);
            checkSpanAttributes(spans, 'raw', CanonicalCode.OK, 'SELECT 2+2');

            expect(spans[0].spanContext.traceId).toEqual(rootSpan.context().traceId);
            expect(spans[0].parentSpanId).toEqual(rootSpan.context().spanId);
        });
    });

    it('should handle await on a thenable query object (query builder)', () => {
        const rootSpan = provider.getTracer('default').startSpan('test span');
        return provider.getTracer('default').withSpan(rootSpan, async () => {
            await connection.select(connection.raw('2+2'));

            const spans = memoryExporter.getFinishedSpans();
            expect(spans).toHaveLength(1);
            checkSpanAttributes(spans, 'select', CanonicalCode.OK, 'select 2+2');

            expect(spans[0].spanContext.traceId).toEqual(rootSpan.context().traceId);
            expect(spans[0].parentSpanId).toEqual(rootSpan.context().spanId);
        });
    });

    it('should handle Promise.all', () => {
        const span = provider.getTracer('default').startSpan('test span');
        return provider.getTracer('default').withSpan(span, async () => {
            return Promise.all([
                await connection.select(connection.raw('2+2')),
                await connection.select(connection.raw('3+3')),
            ]).then(() => {
                span.end();

                const spans = memoryExporter.getFinishedSpans();
                expect(spans).toHaveLength(3);
                expect([...new Set(spans.map((currentSpan) => currentSpan.spanContext.traceId))]).toHaveLength(1);
            });
        });
    });

    it('should handle a combined operation with async/await', () => {
        const span = provider.getTracer('default').startSpan('test span');
        return provider.getTracer('default').withSpan(span, async () => {
            await connection.select(connection.raw('2+2'));
            span.end();

            const spans = memoryExporter.getFinishedSpans();
            expect(spans).toHaveLength(2);
            expect([...new Set(spans.map((currentSpan) => currentSpan.spanContext.traceId))]).toHaveLength(1);
        });
    });

    it('should handle transactions', () => {
        const span = provider.getTracer('default').startSpan('test span');
        return provider.getTracer('default').withSpan(span, async () => {
            await connection.transaction((trx) => {
                return trx.raw('SELECT 2+2');
            });

            const spans = memoryExporter.getFinishedSpans();
            expect(spans).toHaveLength(3);
            expect(spans[1].name).toBe('raw');
        });
    });
});
