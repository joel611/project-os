import type {
  SpanAttributes,
  SpanLink,
  SpanOptions,
  SpanStatus,
  TelemetryCarrier,
  TelemetryContext,
  TelemetryMetrics,
  TelemetryPropagation,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import {
  type Attributes,
  type Context,
  context as otelContext,
  type Meter,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";

export interface OtelTelemetryOptions {
  readonly tracer: Tracer;
  /** Omit to disable the `metrics` capability. */
  readonly meter?: Meter;
}

const toAttributes = (attributes: SpanAttributes | undefined): Attributes => {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value] : (value as string | number | boolean);
  }
  return out;
};

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface OtelContext extends TelemetryContext {
  readonly otel: Context;
  readonly spanContext: SpanContext | undefined;
}

const spanContextOf = (ctx: TelemetryContext): SpanContext | undefined =>
  (ctx as Partial<OtelContext>).spanContext;

const applyStatus = (span: Span, status: SpanStatus) => {
  if (status.status === "ok") span.setStatus({ code: SpanStatusCode.OK });
  else
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(status.error ? { message: `${status.error.name}: ${status.error.message}` } : {}),
    });
};

/**
 * Bridges Pi's vendor-neutral `TelemetryContext` to OpenTelemetry. Pass the result as
 * `HarnessOptions.telemetry`. Needs only `@opentelemetry/api`: with no SDK registered the tracer
 * and meter are no-ops, so wiring an exporter stays the host's choice.
 *
 * Propagation carriers are a W3C `traceparent` only, hand-rolled so trace continuity across
 * queued/reopened Pi tasks does not depend on a global propagator being registered.
 */
export const makeOtelTelemetry = ({ tracer, meter }: OtelTelemetryOptions): TelemetryContext => {
  const propagation: TelemetryPropagation = {
    inject(ctx) {
      const sc = spanContextOf(ctx);
      if (!sc || !trace.isSpanContextValid(sc)) return undefined;
      return {
        traceparent: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`,
      };
    },
    extract(carrier: TelemetryCarrier | undefined) {
      const match = carrier?.traceparent ? TRACEPARENT.exec(carrier.traceparent) : null;
      if (!match) return root;
      return makeContext(
        trace.setSpanContext(ROOT_CONTEXT, {
          traceId: match[1] as string,
          spanId: match[2] as string,
          traceFlags: Number.parseInt(match[3] as string, 16),
          isRemote: true,
        }),
      );
    },
  };

  const metrics: TelemetryMetrics | undefined = meter && {
    counter: (name, options) => {
      const c = meter.createCounter(name, options);
      return { add: (value, attributes) => c.add(value, toAttributes(attributes)) };
    },
    upDownCounter: (name, options) => {
      const c = meter.createUpDownCounter(name, options);
      return { add: (value, attributes) => c.add(value, toAttributes(attributes)) };
    },
    histogram: (name, { boundaries, ...options } = {}) => {
      const h = meter.createHistogram(name, {
        ...options,
        ...(boundaries ? { advice: { explicitBucketBoundaries: [...boundaries] } } : {}),
      });
      return {
        record: (value, attributes, ctx) =>
          h.record(value, toAttributes(attributes), (ctx as Partial<OtelContext>)?.otel),
      };
    },
  };

  const capabilities = { propagation, ...(metrics ? { metrics } : {}) };

  const makeContext = (otel: Context): OtelContext => ({
    ...capabilities,
    otel,
    spanContext: trace.getSpanContext(otel),
    startSpan: (options, callback) => runSpan(otel, options, callback),
  });

  async function runSpan<T>(
    parent: Context,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const links = (options.links ?? []).flatMap((link) => {
      const context = spanContextOf(link.context);
      return context
        ? [{ context, ...(link.attributes ? { attributes: toAttributes(link.attributes) } : {}) }]
        : [];
    });
    const span = tracer.startSpan(
      options.name,
      { attributes: toAttributes(options.attributes), links },
      parent,
    );
    const child = trace.setSpan(parent, span);
    let status: SpanStatus = { status: "ok" };
    const wrapper: TelemetrySpan = {
      ...makeContext(child),
      addLink: (link: SpanLink) => {
        const context = spanContextOf(link.context);
        if (context) span.addLink({ context, attributes: toAttributes(link.attributes) });
      },
      addEvent: (name, attributes) => span.addEvent(name, toAttributes(attributes)),
      setAttributes: (attributes) => span.setAttributes(toAttributes(attributes)),
      setStatus: (next) => {
        status = next;
      },
    };
    try {
      return await otelContext.with(child, () => callback(wrapper));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      status = { status: "error", error: { name: e.name, message: e.message } };
      throw error;
    } finally {
      applyStatus(span, status);
      span.end();
    }
  }

  const root = makeContext(ROOT_CONTEXT);
  return root;
};
