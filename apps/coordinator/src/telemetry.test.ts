import { describe, expect, it } from "vite-plus/test";
import { setupTelemetry } from "./telemetry.ts";

describe("setupTelemetry", () => {
  it("is off without an OTLP endpoint", () => {
    expect(setupTelemetry({})).toBeUndefined();
  });

  it.each(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"])(
    "is on when %s is set, and defaults the service name",
    (key) => {
      const env: Record<string, string | undefined> = { [key]: "http://localhost:4318" };
      const telemetry = setupTelemetry(env);
      expect(telemetry?.propagation).toBeDefined();
      expect(telemetry?.metrics).toBeDefined();
      expect(env.OTEL_SERVICE_NAME).toBe("project-os-coordinator");
    },
  );

  it("keeps a configured service name", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SERVICE_NAME: "custom" };
    setupTelemetry(env);
    expect(env.OTEL_SERVICE_NAME).toBe("custom");
  });
});
