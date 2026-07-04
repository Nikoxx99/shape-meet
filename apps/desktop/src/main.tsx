import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import {
  getDesktopRuntimeConfig,
  type NativeDesktopRuntimeConfig,
} from "./lib/native";
import "./styles.css";

void bootstrap();

async function bootstrap() {
  const runtimeConfig = await getDesktopRuntimeConfig();
  initSentry(runtimeConfig);

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <App />
    </Sentry.ErrorBoundary>,
  );
}

function initSentry(runtimeConfig: NativeDesktopRuntimeConfig) {
  const sentryDsn = runtimeConfig.sentryDsn;

  if (!sentryDsn) return;

  Sentry.init({
    dsn: sentryDsn,
    environment: runtimeConfig.sentryEnvironment,
    release: runtimeConfig.sentryRelease,
    tracesSampleRate: Number.isFinite(runtimeConfig.sentryTracesSampleRate)
      ? runtimeConfig.sentryTracesSampleRate
      : 1,
    debug: runtimeConfig.sentryDebug,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        "app.surface": "desktop-webview",
        "shape.config.runtime": runtimeConfig.configPath ? "file" : "build",
      },
    },
    beforeSend(event) {
      event.contexts = {
        ...event.contexts,
        mediaPolicy: {
          frames: "not-collected",
          audio: "not-collected",
          sourceImages: "not-collected",
          modelArtifacts: "not-collected",
        },
      };
      return event;
    },
  });
}

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
