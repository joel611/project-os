import { makeOtelTelemetry } from "@project-os/agent-runtime";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * OTLP/HTTP telemetry for Pi Durable, off unless an endpoint is configured. The exporters read the
 * standard `OTEL_EXPORTER_OTLP_*` variables (endpoint, headers, timeouts). The service name comes
 * from `OTEL_SERVICE_NAME` (the SDK does not read it itself), default `project-os-coordinator`.
 */
export const setupTelemetry = (
  env: Record<string, string | undefined>,
):
  | {
      readonly telemetry: ReturnType<typeof makeOtelTelemetry>;
      readonly shutdown: () => Promise<void>;
    }
  | undefined => {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return undefined;
  const resource = resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME ?? "project-os-coordinator",
  });

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  });
  return {
    telemetry: makeOtelTelemetry({
      tracer: tracerProvider.getTracer("project-os"),
      meter: meterProvider.getMeter("project-os"),
    }),
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
};
