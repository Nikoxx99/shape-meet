"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="es">
      <body>
        <main className="admin-login-shell">
          <section className="admin-login-card">
            <h1>No se pudo cargar el panel</h1>
            <button className="primary-button full" type="button" onClick={reset}>
              Reintentar
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
