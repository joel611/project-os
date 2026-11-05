import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentRuntime } from "@project-os/core";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeAgentRuntime, makeOtelTelemetry } from "./index.ts";

const setupOtel = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const telemetry = makeOtelTelemetry({
    tracer: provider.getTracer("test"),
    meter: meterProvider.getMeter("test"),
  });
  return { exporter, metricExporter, reader, telemetry };
};

describe("makeOtelTelemetry", () => {
  it("nests child spans, records events/attributes, and ends them", async () => {
    const { exporter, telemetry } = setupOtel();

    await telemetry.startSpan({ name: "parent", attributes: { a: 1, skip: undefined } }, (p) =>
      p.startSpan({ name: "child" }, (c) => {
        c.addEvent("evt", { k: "v" });
        c.setAttributes({ list: ["x", "y"] });
      }),
    );

    const [child, parent] = exporter.getFinishedSpans();
    expect(child?.name).toBe("child");
    expect(parent?.name).toBe("parent");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    expect(parent?.attributes).toEqual({ a: 1 });
    expect(child?.attributes.list).toEqual(["x", "y"]);
    expect(child?.events[0]?.name).toBe("evt");
    expect(child?.status.code).toBe(1);
  });

  it("marks span errored and rethrows when the callback throws", async () => {
    const { exporter, telemetry } = setupOtel();

    await expect(
      telemetry.startSpan({ name: "boom" }, () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.status.message).toBe("Error: nope");
  });

  it("honours setStatus and links", async () => {
    const { exporter, telemetry } = setupOtel();
    let other: Parameters<Parameters<typeof telemetry.startSpan>[1]>[0] | undefined;
    await telemetry.startSpan({ name: "other" }, (s) => {
      other = s;
    });
    await telemetry.startSpan({ name: "linked", links: [{ context: other as never }] }, (s) =>
      s.setStatus({ status: "error", error: { name: "E", message: "m" } }),
    );

    const [otherSpan, linked] = exporter.getFinishedSpans();
    expect(linked?.status.code).toBe(2);
    expect(linked?.links[0]?.context.spanId).toBe(otherSpan?.spanContext().spanId);
  });

  it("round-trips a trace through propagation carriers", async () => {
    const { exporter, telemetry } = setupOtel();
    const { propagation } = telemetry;
    expect(propagation).toBeDefined();
    expect(propagation?.inject(telemetry)).toBeUndefined();

    const carrier = await telemetry.startSpan({ name: "origin" }, (s) => propagation?.inject(s));
    expect(carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await propagation?.extract(carrier).startSpan({ name: "resumed" }, () => {});
    const [origin, resumed] = exporter.getFinishedSpans();
    expect(resumed?.spanContext().traceId).toBe(origin?.spanContext().traceId);
    expect(resumed?.parentSpanContext?.spanId).toBe(origin?.spanContext().spanId);

    expect(propagation?.extract({ traceparent: "garbage" })).toBe(telemetry);
    expect(propagation?.extract(undefined)).toBe(telemetry);
  });

  it("records metrics", async () => {
    const { metricExporter, reader, telemetry } = setupOtel();
    telemetry.metrics?.counter("c").add(2, { t: "x" });
    telemetry.metrics?.histogram("h", { boundaries: [1, 5] }).record(3);
    await reader.forceFlush();

    const names = metricExporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.descriptor.name)));
    expect(names.sort()).toEqual(["c", "h"]);
  });

  it("omits metrics capability without a meter", () => {
    const t = makeOtelTelemetry({
      tracer: new BasicTracerProvider().getTracer("x"),
    });
    expect(t.metrics).toBeUndefined();
  });

  it("emits Pi Durable spans when passed to the runtime", async () => {
    const { exporter, telemetry } = setupOtel();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const m = faux.getModel();
    faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* Layer.build(
            makeAgentRuntime({
              storage: new MemoryStorage(),
              models,
              model: { provider: m.provider, modelId: m.id },
              telemetry,
            }),
          );
          return yield* Context.get(ctx, AgentRuntime).respond({
            sessionId: "project:p1",
            prompt: "hello",
          });
        }),
      ),
    );

    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.some((n) => n.startsWith("pi.durable"))).toBe(true);
    expect(names).toContain("pi.ai.request");
  });
});
