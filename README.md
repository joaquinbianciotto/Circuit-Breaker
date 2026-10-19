# Resilience Lab

Ejecuta un experimento HTTP real de circuit breaker / tiempo de espera / reintentos, representado como un instrumento eléctrico.

```sh
docker compose up --build
```

Abrí **http://localhost:3000**. Solo se requiere **Docker con Docker Compose**; las compilaciones instalan dentro de los contenedores las dependencias fijadas en el archivo de bloqueo. No se necesita Node/npm en el equipo anfitrión, un archivo de entorno, una base de datos ni una cuenta. Esperá a que los tres servicios estén saludables. Para iniciar en segundo plano: `docker compose up --build -d --wait`.

El puerto publicado se puede cambiar con `FRONTEND_PORT` (3000 por defecto); siempre queda limitado a `127.0.0.1`. `FRONTEND_PORT=0` permite que Docker asigne un puerto libre, consultable con `docker compose port frontend 80`.

Seleccioná **Normal Response → Send Request**, o **Start Auto Demo** para la secuencia real guiada. Las [guías de cuatro escenarios de uso para presentar con un proyector](docs/scenarios.md) explican exactamente qué pulsar y qué contar.

## Prueba directa de caída y recuperación

Como alternativa a lo presentado en docs/scenarios.md, una forma directa de probar el circuit breaker es detener y recrear únicamente el contenedor de `external-api`, sin reiniciar `backend` ni `frontend` ni cambiar la configuración:

1. Detené el servicio externo: `docker compose stop resilience-lab-external-api-1`.
2. Enviá solicitudes con **Send Request** mientras no esté disponible para observar los fallos y, al alcanzarse los umbrales configurados, la apertura del circuito. Detener el contenedor por sí solo no abre el circuito.
3. Recreá solo ese servicio y esperá a que esté saludable: `docker compose up external-api`.
4. Tras la espera de recuperación configurada (**7 s** por defecto), cuando la interfaz muestre **LIVE GATE HALF_OPEN**, pulsá **Send Request** para observar la sonda y, si tiene éxito, el cierre del circuito.

## Detención 

Pulsá Ctrl-C si Compose se ejecuta en primer plano. Para detener y eliminar los contenedores y la red de este proyecto:

```sh
docker compose down
```

## Servicios en ejecución

| Servicio | Entorno de ejecución de producción | Acceso |
| --- | --- | --- |
| `frontend` | Compilación de React/TypeScript/Vite/Tailwind servida por nginx | Único puerto publicado: `127.0.0.1:3000:80` |
| `backend` | NestJS + Opossum compilados, Node 22.22.2 | Solo en la red de Docker, puerto 3001 |
| `external-api` | Fastify compilado, Node 22.22.2 | Solo en la red de Docker, puerto 3002 |

El navegador utiliza `/api` en el mismo origen, incluido SSE sin almacenamiento en búfer a través de nginx. En el backend, `EXTERNAL_API_URL` es `http://external-api:3002`. Cada intento envía una solicitud HTTP real a ese servicio externo, con identificadores de solicitud/intento y métricas reales de recepción/cancelación. **Tres servicios de red no son tres circuit breakers ilustrados:** un circuit breaker envuelve una operación lógica que contiene todos sus intentos acotados.

## Valores predeterminados y su significado

| Política de protección | Valor predeterminado |
| --- | --- |
| Tiempo de espera por intento, incluido el cuerpo de la respuesta | 800 ms |
| Reintentos adicionales | 2 (hasta 3 intentos) |
| Esperas entre reintentos | 200 ms y luego 400 ms |
| Tiempo límite total de la operación | 3000 ms, incluidas las esperas y la sobrecarga |
| Umbral de apertura | >50% de fallos sobre llamadas a `fire()`, según las estadísticas nativas de Opossum |
| Volumen mínimo de llamadas al circuito | 4 |
| Ventana móvil | 20 s |
| Espera de recuperación en OPEN | 7 s |

Una operación lógica llama una sola vez al circuito, aunque tenga reintentos. El denominador nativo incluye llamadas pendientes y rechazos de Opossum; la apertura estadística se evalúa cuando falla una operación. Exactamente 50% no abre un umbral de 50%. No hay un ledger personalizado: los detalles y las métricas están en la [guía del motor](docs/engine.md#native-opossum-statistics), y la [verificación aislada sobre Compose](docs/verification.md#current-compose-only-workflow) no modifica el stack de presentación.
