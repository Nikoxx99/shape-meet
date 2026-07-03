import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import "./styles.css";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const sentryTracesSampleRate = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "1");
const sentryDebug = ["1", "true", "yes"].includes(
  String(import.meta.env.VITE_SENTRY_DEBUG ?? "").toLowerCase()
);

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    tracesSampleRate: Number.isFinite(sentryTracesSampleRate) ? sentryTracesSampleRate : 1,
    debug: sentryDebug,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        "app.surface": "desktop-webview"
      }
    },
    beforeSend(event) {
      event.contexts = {
        ...event.contexts,
        mediaPolicy: {
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary fallback={<CrashFallback />}>
    <App />
  </Sentry.ErrorBoundary>
);

function CrashFallback() {
  return (
    <main className="crash-screen">
      <section>
        <h1>La aplicación encontró un error.</h1>
        <button type="button" onClick={() => window.location.reload()}>
          Reiniciar
        </button>
      </section>
    </main>
  );
}
