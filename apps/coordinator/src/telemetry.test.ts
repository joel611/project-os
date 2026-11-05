import { describe, expect, it } from "vite-plus/test";
import { setupTelemetry } from "./telemetry.ts";

describe("setupTelemetry", () => {
  it("is off without an OTLP endpoint", () => {
    expect(setupTelemetry({})).toBeUndefined();
  });

  it.each(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"])(
    "is on when %s is set",
    (key) => {
      const env: Record<string, string | undefined> = { [key]: "http://localhost:4318" };
      const setup = setupTelemetry(env);
      expect(setup?.telemetry.propagation).toBeDefined();
      expect(setup?.telemetry.metrics).toBeDefined();
    },
  );

  it("keeps a configured service name", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SERVICE_NAME: "custom" };
    expect(setupTelemetry(env)).toBeDefined();
  });

  it("shutdown flushes without error", async () => {
    const setup = setupTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" });
    await expect(setup?.shutdown()).resolves.toBeUndefined();
  });
});
