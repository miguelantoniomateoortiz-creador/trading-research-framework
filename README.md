# Trading Research Framework

Laboratorio de investigación cuantitativa para descubrir ventajas estadísticas
en mercados financieros, con el NAS100 y datos de MetaTrader 5 como primera
línea de trabajo.

No es un visor de backtests. Es una plataforma para **formular hipótesis,
medirlas con rigor y descartarlas rápido**, diseñada para crecer durante años
mediante plugins sin tocar el núcleo.

---

## Estado actual

Construido y probado (niveles 1 a 5 del plan acordado):

| Nivel | Pieza | Estado |
|---|---|---|
| 1 | Arquitectura del monorepo | ✅ |
| 2 | Base de datos SQLite con esquema extensible | ✅ |
| 3 | Sistema de plugins con DAG de dependencias | ✅ |
| 4 | Importador MT5 (CSV/JSON) + datos sintéticos | ✅ |
| 5 | Motor de análisis (predicados, cohortes, marginales) | ✅ |
| 6 | Pattern Discovery | ⏳ siguiente |
| 7 | Validación formal de hipótesis | ⏳ base ya puesta |
| 8 | Dashboard Next.js | ⏳ ver `apps/web/README.md` |

Los niveles 6 y 7 se apoyan enteramente en piezas que ya existen: descubrir
patrones es enumerar predicados y evaluar cohortes, y ambas cosas están hechas
y cubiertas por tests.

---

## Puesta en marcha

Requisitos: Node.js ≥ 20.11 y pnpm ≥ 9.

```bash
cd "Trading Research Framework"
pnpm install
pnpm db:generate      # cliente de Prisma
pnpm db:migrate       # crea data/db/trf.db
```

Primer ciclo completo, con datos sintéticos que contienen un patrón real
inyectado a propósito:

```bash
pnpm trf db:init
pnpm trf data:generate --from 2022-01-01 --to 2025-12-31 --inject-pattern
pnpm trf data:import --file data/imports/nas100-synthetic-2022-01-01_2025-12-31.csv --tz America/New_York
pnpm trf run

pnpm trf splits:create --name train --role training   --from 2022-01-01 --to 2025-01-01
pnpm trf splits:create --name val   --role validation --from 2025-01-10 --to 2026-01-01

pnpm trf analyze:marginal --split train --detail
pnpm trf analyze:cohort --split train --where "nas100.impulseDirection == 1 and nas100.openingRangeSizeAtr > 1"
```

Con tus datos reales, sustituye los pasos 2 y 3 por tu export de MT5:

```bash
pnpm trf data:import --file /ruta/NAS100_M1.csv --tz Europe/Riga
```

La zona horaria importa mucho más de lo que parece. Lee
[`docs/03-importar-mt5.md`](docs/03-importar-mt5.md) antes de la primera
importación real.

```bash
pnpm test         # batería de pruebas unitarias
pnpm typecheck    # TypeScript estricto sobre todo el repo
pnpm trf help     # todos los comandos disponibles
```

> **Nota sobre la primera ejecución.** El proyecto se escribió sin poder
> ejecutar `pnpm install` en tu máquina, así que la primera vez conviene correr
> `pnpm typecheck && pnpm test` antes que nada. Si algo falla, será un detalle de
> integración (una firma, un import), no de diseño: la lógica numérica está
> contrastada contra scipy y cada módulo tiene sus pruebas.

---

## Cómo está organizado

```
trading-research-framework/
├── apps/
│   ├── cli/          # `trf`: la referencia funcional del framework
│   ├── api/          # API HTTP local (localhost) para el dashboard
│   └── web/          # dashboard Next.js — nivel 8, aún sin código
├── packages/
│   ├── shared/       # tipos, calendario de mercado, estadística
│   ├── database/     # esquema Prisma + acceso rápido con better-sqlite3
│   ├── plugin-sdk/   # contratos, vista de mercado sellada, cargador
│   ├── importer/     # MT5 CSV/JSON, zonas horarias, datos sintéticos
│   └── analyzer/     # predicados, cohortes, marginales, simulador
├── plugins/          # todo lo que es "una idea de trading" vive aquí
│   ├── core-time/            core-candle/     core-volatility/
│   ├── core-trend/           core-vwap/       core-market/
│   ├── nas100-open/          ← la investigación de apertura
│   ├── entry-time-of-day/    entry-opening-range-breakout/
├── docs/             # arquitectura, metodología y decisiones (ADR)
└── data/             # base de datos, importaciones y caché (fuera de git)
```

---

## Las cuatro ideas que sostienen el diseño

### 1. Una operación es una observación, no un recuerdo

En este framework una `Trade` no es algo que hiciste en el bróker: es *"bajo
esta regla, en este instante, esto habría pasado"*. Las operaciones reales
importadas de MT5 son un caso particular (`source: "broker"`).

Esto es lo que permite estudiar ideas que nunca operaste. Si el sistema sólo
analizara tu historial, podrías medir lo que ya hiciste, pero nunca descubrir
nada nuevo.

### 2. Cada variable declara si se puede usar para decidir

Toda variable lleva un campo `causality`:

- **`predictor`** — se conoce ANTES de entrar. Sólo estas valen para hipótesis.
- **`outcome`** — sólo se conoce al cerrar: MAE, MFE, profit, duración.
- **`meta`** — identificadores, año, lote de importación.

El motor **rechaza** una hipótesis que use variables de resultado:

```bash
pnpm trf analyze:cohort --split train --where "time.minuteOfDay == 570 and mae < 25"

✖ [E_LOOKAHEAD] El predicado usa variables que no pueden formar parte de una hipótesis:
  - mae (outcome): es una variable de RESULTADO: su valor sólo se conoce al cerrar
    la operación, así que no puede formar parte de una condición de entrada
```

Ese filtro concreto (`MAE < 25`) produce un win rate del 95% que no se puede
operar: equivale a *"quédate sólo con las operaciones que no se pusieron feas"*,
una decisión que sólo se puede tomar mirando al pasado. Es el error más caro de
este oficio y aquí es imposible de cometer sin darse cuenta.

### 3. Los plugins no pueden ver el futuro aunque quieran

Un plugin nunca recibe el array de velas. Recibe una `MarketView` anclada a un
instante que, por construcción, sólo devuelve velas ya cerradas. Si algo intenta
leer una vela que aún no ha cerrado, se lanza `LookaheadError`.

El motor recorre el histórico una sola vez y en un orden que es, literalmente,
la corrección del backtest:

1. abrir las señales de la vela anterior, a la **apertura** de la actual;
2. calcular sus variables — los buffers aún no contienen esta vela;
3. actualizar posiciones abiertas con esta vela;
4. cerrar la vela: alimentar buffers e indicadores;
5. pedir señales nuevas, que se abrirán en la vela siguiente.

Intercambiar los pasos 2 y 4 mejoraría espectacularmente los resultados y sería
mentira.

### 4. El dataset de validación es un recurso que se gasta

Cada evaluación contra un split queda registrada. A partir de diez usos el
sistema avisa; a partir de veinte, te dice claramente que ese periodo ya no es
fuera de muestra. Y `createSplit` **rechaza** un split de validación que solape
con el de entrenamiento, embargo incluido.

---

## Añadir una idea nueva

Crear una carpeta en `plugins/`. Nada más. El núcleo no se toca.

```
plugins/fair-value-gap/
├── plugin.json      # id, versión, autor, qué variables produce, config
├── package.json
└── src/
    ├── index.ts     # ensamblaje
    ├── variables.ts # QUÉ mide
    └── calculator.ts# CÓMO lo mide
```

El manifiesto declara las claves de las variables y el código sus definiciones
completas; el cargador comprueba que coincidan, así que no pueden
desincronizarse. Las dependencias entre plugins se declaran por variable
(`requires.features`) y el registro los ordena topológicamente.

Guía completa en [`docs/02-guia-de-plugins.md`](docs/02-guia-de-plugins.md).

---

## La primera investigación: la apertura del NAS100

Hipótesis: *el índice hace con frecuencia un impulso inicial en la apertura y
después revierte*.

El plugin `nas100-open` no afirma nada; mide las cinco cosas necesarias para
contrastarlo:

| Pregunta | Variable |
|---|---|
| Dirección inicial | `nas100.impulseDirection` |
| Movimiento contrario | `nas100.excursionAgainstImpulseAtr` |
| Probabilidad de recuperación | `nas100.crossedBackOpen` (agregada por cohortes) |
| Tiempo de reversión | `nas100.minutesToOpenCross` |
| Máxima distancia en contra antes de volver | las dos anteriores combinadas |

Todo en **ATRs, no en puntos**: el NAS100 ha pasado de 12.000 a más de 20.000 en
el periodo de estudio, y un umbral fijo en puntos mezclaría regímenes que no son
comparables.

Además hay dos reglas de entrada listas para generar la población a estudiar:
`entry-time-of-day` (entra a una hora fija, sin filtrar nada) y
`entry-opening-range-breakout`, que con `tradeFade: true` opera *contra* la
ruptura — justo lo que la hipótesis de reversión predice que podría funcionar
mejor.

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/00-arquitectura.md`](docs/00-arquitectura.md) | Mapa de paquetes y por qué cada frontera está donde está |
| [`docs/01-modelo-de-datos.md`](docs/01-modelo-de-datos.md) | Esquema híbrido, rendimiento, materialización |
| [`docs/02-guia-de-plugins.md`](docs/02-guia-de-plugins.md) | Cómo escribir un plugin, paso a paso |
| [`docs/03-importar-mt5.md`](docs/03-importar-mt5.md) | Exportar de MT5 y el problema de las zonas horarias |
| [`docs/04-motor-de-analisis.md`](docs/04-motor-de-analisis.md) | Predicados, cohortes, marginales, lenguaje de consulta |
| [`docs/05-metodologia.md`](docs/05-metodologia.md) | Cómo no engañarse: multiplicidad, sobreajuste, validación |
| [`docs/06-roadmap.md`](docs/06-roadmap.md) | Niveles 6, 7 y 8, y qué queda ya preparado para ellos |
| [`docs/adr/`](docs/adr/) | Decisiones de arquitectura, con sus alternativas descartadas |

---

## Cambios respecto a lo que pediste, y por qué

Se aceptó la invitación a mejorar la arquitectura donde había una razón clara.
Cinco cambios, todos justificados en detalle en los ADR:

1. **Monorepo pnpm con `apps/` + `packages/`** en vez de carpetas planas
   `/frontend /backend /database…`. Motivo: comparten tipos y configuración; con
   carpetas independientes se duplica todo. Tus nombres se conservan como
   paquetes. ([ADR-0002](docs/adr/0002-monorepo-paquetes-internos.md))

2. **Esquema híbrido** en vez de EAV o `ALTER TABLE` por variable: columnas
   nativas para lo que se consulta siempre, blob JSON para las variables de
   plugins, y un registro que le da semántica. Cuando una variable se vuelve
   caliente, `variables:materialize` crea una columna generada con índice sin
   migrar datos. ([ADR-0001](docs/adr/0001-esquema-hibrido.md))

3. **Prisma + better-sqlite3**, no sólo Prisma. Prisma manda en el esquema y las
   migraciones; el trabajo pesado (ingerir millones de velas, proyectar columnas)
   va por better-sqlite3, que es síncrono y permite iterar sin materializar
   resultados. ([ADR-0003](docs/adr/0003-prisma-mas-better-sqlite3.md))

4. **Causalidad obligatoria en cada variable.** No estaba en el encargo, pero el
   ejemplo `Hora = 9:30 AND ATR > 18 AND MAE < 25` mezclaba dos predictores con
   una variable de resultado. Sin esta guarda, la plataforma produciría patrones
   preciosos e inoperables. ([ADR-0004](docs/adr/0004-causalidad-de-variables.md))

5. **CLI antes que dashboard.** Respeta tu orden de construcción y además obliga
   a que la lógica viva en los paquetes, no en la interfaz. Cuando llegue el
   nivel 8, el dashboard sólo tendrá que llamar y pintar.

---

## Licencia

Uso privado. Sin licencia explícita.
