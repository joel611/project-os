import { makeOtelTelemetry } from "@project-os/agent-runtime";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * OTLP/HTTP telemetry for Pi Durable, off unless an endpoint is configured. The exporters read the
 * standard `OTEL_EXPORTER_OTLP_*` variables (endpoint, headers, protocol timeouts), and the SDK
 * reads `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`.
 */
export const setupTelemetry = (
  env: Record<string, string | undefined>,
): ReturnType<typeof makeOtelTelemetry> | undefined => {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return undefined;
  env.OTEL_SERVICE_NAME ??= "project-os-coordinator";

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  const meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  });
  return makeOtelTelemetry({
    tracer: tracerProvider.getTracer("project-os"),
    meter: meterProvider.getMeter("project-os"),
  });
};
