import * as Sentry from "@sentry/nextjs";

const tracesSampleRate = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "1");
const debug = ["1", "true", "yes"].includes(
  String(process.env.NEXT_PUBLIC_SENTRY_DEBUG ?? "").toLowerCase()
);

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
