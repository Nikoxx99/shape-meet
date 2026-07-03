import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1");
const debug = ["1", "true", "yes"].includes(String(process.env.SENTRY_DEBUG ?? "").toLowerCase());

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? "shape-meet-admin@0.1.0",
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1,
    debug,
    sendDefaultPii: false,
    beforeSend(event) {
      event.contexts = {
        ...event.contexts,
        privacy: {
          frames: "not-collected",
          audio: "not-collected",
          sourceImages: "not-collected",
          modelArtifacts: "not-collected"
        }
      };
      return event;
    }
  });
}
