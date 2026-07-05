// Preload para el servidor standalone de Next.js.
//
// Coolify enruta con Traefik, cuyo pool de conexiones keep-alive usa un
// idleConnTimeout por defecto de 90 s. El servidor HTTP de Node cierra las
// conexiones ociosas a los 5 s (keepAliveTimeout por defecto). Cuando Traefik
// reutiliza una conexión que Node ya cerró, la petición cae en un socket
// muerto y Traefik responde 504 Gateway Timeout de forma intermitente.
//
// Subimos keepAliveTimeout por encima del idleConnTimeout de Traefik y
// headersTimeout aún más arriba para eliminar el race. Se inyecta con
// `node -r ./keepalive.js server.js` porque el server standalone no acepta
// flags para configurar estos timeouts.
const http = require("http");

const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  // 120s > 90s (idleConnTimeout de Traefik); headersTimeout debe ser mayor.
  this.keepAliveTimeout = 120000;
  this.headersTimeout = 125000;
  return originalListen.apply(this, args);
};
