# Arquitectura

## Principio rector

El núcleo no sabe nada de estrategias. Sabe de velas, operaciones, variables y
estadística. Todo lo que es "una idea de trading" vive en `plugins/`.

Esta separación es la que permite que el proyecto siga vivo dentro de cinco
años: las ideas cambian constantemente, la infraestructura no.

## Mapa de dependencias

```
                    ┌──────────────┐
                    │ @trf/shared  │   tipos, calendario, estadística
                    └──────┬───────┘   (no depende de nada)
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
     ┌──────────────┐ ┌──────────┐ ┌─────────────┐
     │@trf/database │ │@trf/     │ │             │
     │              │ │plugin-sdk│ │             │
     └──────┬───────┘ └────┬─────┘ │             │
            │              │       │             │
            ▼              │       │             │
     ┌──────────────┐      │       │  plugins/*  │
     │@trf/importer │      │◄──────┤  (sólo ven  │
     └──────┬───────┘      │       │  shared +   │
            │              │       │  plugin-sdk)│
            ▼              ▼       └─────────────┘
     ┌─────────────────────────┐
     │      @trf/analyzer      │
     └────────────┬────────────┘
        ┌─────────┼─────────┐
        ▼         ▼         ▼
     apps/cli  apps/api  apps/web
```

Reglas que no se rompen:

1. **`shared` no depende de nadie.** Si un tipo lo usan dos paquetes, va ahí.
2. **Los plugins sólo importan `@trf/shared` y `@trf/plugin-sdk`.** Nunca la
   base de datos ni el analizador. Así el núcleo puede reescribirse por dentro
   sin romper plugins de terceros.
3. **Las apps no contienen lógica.** Si una pantalla o un comando necesita un
   cálculo nuevo, se implementa en un paquete. El CLI y la API deben producir
   resultados idénticos porque llaman al mismo código.

## Los cinco paquetes

### `@trf/shared`

Vocabulario común: `Bar`, `Trade`, `VariableDefinition`, `DatasetSplit`, el
calendario de mercado y la librería estadística (Wilson, t-test, Benjamini-
Hochberg, bootstrap, métricas de cohorte).

Detalle importante: **todo se almacena en epoch ms UTC** y las partes de fecha
se derivan siempre en la zona horaria del *mercado*, no del bróker ni del
ordenador. Ver `src/time/calendar.ts`.

### `@trf/database`

Dos capas complementarias:

- `prisma/schema.prisma` — fuente de verdad del esquema y las migraciones.
- `src/` — acceso de runtime con better-sqlite3, orientado a streaming e
  inserción por lotes.

Todo lo que puede devolver muchas filas es un generador, no un array.

### `@trf/plugin-sdk`

Contratos (`FeaturePlugin`, `EntryPlugin`), la `MarketView` sellada
anti-lookahead, indicadores incrementales (EMA, ATR de Wilder, VWAP de sesión,
rachas), el registro con resolución de dependencias y el cargador dinámico.

### `@trf/importer`

Lector CSV/TSV por streaming, parser tolerante del formato MT5, normalización
de zonas horarias, orquestación por lotes con trazabilidad, y un generador de
datos sintéticos deterministas que puede inyectar un patrón conocido.

### `@trf/analyzer`

Dos mitades:

- **Generación**: `runner` + `simulator` convierten velas y plugins de entrada
  en operaciones con variables.
- **Análisis**: `feature-matrix` (columnar), `predicate` (AST), `cohort`
  (máscaras de bits), `marginal` (tramos) y `guards` (anti-lookahead).

## El orden del recorrido

`runner.ts` recorre el histórico **una sola vez**, y el orden dentro de cada
vela no es un detalle de implementación: es la corrección del backtest.

```
para cada vela B:
  1. abrir señales pendientes → precio = B.open, entryTs = B.ts
  2. calcular sus variables    → los buffers contienen hasta B-1
  3. actualizar posiciones abiertas con B (MAE/MFE, TP/SL, tiempo)
  4. cerrar B: buffers, agregados diarios, plugin.onBar()
  5. plugins de entrada con now = cierre de B → pendientes para B+1
```

Si los pasos 2 y 4 se intercambian, cada plugin ve el cierre de la vela en la
que entra. El backtest mejora muchísimo y el sistema real pierde dinero.

## Rendimiento

| Problema | Solución |
|---|---|
| Millones de velas no caben en memoria | Generadores en todo el acceso a datos |
| Reconstruir indicadores por vela es O(n·período) | Indicadores incrementales O(1) |
| Guardar M1+M5+M15+H1 duplica la verdad | Sólo M1; los superiores se agregan al vuelo |
| Miles de predicados sobre los mismos datos | Matriz columnar cargada una vez |
| Evaluar árboles fila a fila | Máscaras de bits vectorizadas por columna |
| `json_extract` en un WHERE escanea la tabla | Materialización a columna generada + índice |
| Un `INSERT` por fila hace fsync | Lotes en una única transacción |

Las cuatro últimas son las que convierten "responder en 4 segundos" en
"responder al instante", que es la diferencia entre explorar y esperar.
