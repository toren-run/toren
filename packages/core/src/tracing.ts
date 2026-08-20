import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

// Resolved per call: hosts may register their OTel SDK after toren is imported.
const tracer = () => trace.getTracer("toren");

/**
 * Every model call, tool invocation, task, and tick emits a
 * standard span. No-op unless the host registers an OTel SDK/exporter.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}
