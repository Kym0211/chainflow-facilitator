import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";

const METRICS_PORT = 9464; // Standard Prometheus exporter port

// Create the Prometheus exporter — this serves a /metrics endpoint
// that Prometheus scrapes on a schedule
const exporter = new PrometheusExporter({ port: METRICS_PORT }, () => {
  console.log(`Metrics available at http://localhost:${METRICS_PORT}/metrics`);
});

// Create a meter provider and register the exporter
const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({
    "service.name": "chainflow-facilitator",
  }),
  readers: [exporter],
});

// Create a meter — this is what we use to create individual metrics
const meter = meterProvider.getMeter("chainflow-facilitator");

// --- Counters (things that only go up) ---

// Total verify requests, labeled by result
export const verifyCounter = meter.createCounter("facilitator_verify_total", {
  description: "Total number of verify requests",
});

// Total settle requests, labeled by result
export const settleCounter = meter.createCounter("facilitator_settle_total", {
  description: "Total number of settle requests",
});

// --- Histograms (track distributions of values) ---

// How long verify takes in milliseconds
export const verifyDuration = meter.createHistogram("facilitator_verify_duration_ms", {
  description: "Verify request duration in milliseconds",
});

// How long settle takes in milliseconds
export const settleDuration = meter.createHistogram("facilitator_settle_duration_ms", {
  description: "Settle request duration in milliseconds",
});

// --- Gauges (values that go up and down) ---

// Number of requests currently being processed
export const activeRequests = meter.createUpDownCounter("facilitator_active_requests", {
  description: "Number of requests currently being processed",
});