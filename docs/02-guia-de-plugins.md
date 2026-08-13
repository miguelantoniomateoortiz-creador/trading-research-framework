# Guía de plugins

Añadir una idea al laboratorio es crear una carpeta en `plugins/`. El núcleo no
se toca nunca.

## Anatomía

```
plugins/mi-plugin/
├── plugin.json      # metadatos: se leen SIN ejecutar código
├── package.json
└── src/
    ├── index.ts     # ensamblaje y export por defecto
    ├── variables.ts # QUÉ mide  (recomendado a partir de ~5 variables)
    └── calculator.ts# CÓMO lo mide
```

Los plugins pequeños del núcleo caben en un solo `index.ts`; `nas100-open` usa
la división completa y sirve de referencia.

## `plugin.json`

```json
{
  "id": "fair-value-gap",
  "name": "Detector de Fair Value Gaps",
  "version": "1.0.0",
  "author": "Miguel",
  "description": "Detecta huecos de ineficiencia de tres velas y mide su tamaño y distancia.",
  "apiVersion": 1,
  "kind": ["feature"],
  "entry": "./src/index.ts",
  "requires": {
    "timeframes": ["M1", "M15"],
    "features": ["volatility.atr"],
    "warmupBars": 50
  },
  "provides": ["fvg.exists", "fvg.sizeAtr", "fvg.distanceAtr", "fvg.ageMinutes"],
  "config": { "minSizeAtr": 0.3, "maxAgeMinutes": 240 },
  "enabledByDefault": true
}
```

Por qué el manifiesto es metadatos puros: el dashboard puede listar plugins,
mostrar qué variables aportan y activarlos o desactivarlos **sin importar ni una
línea de su código**. Un plugin desactivado no se ejecuta nunca, así que un
plugin roto no puede tumbar la plataforma.

`provides` lista las claves; el código exporta las definiciones completas. El
cargador comprueba que coincidan y falla con un mensaje claro si no.

`requires.features` declara dependencias **por variable**, no por plugin. El
registro construye el grafo, lo ordena topológicamente y detecta ciclos y
dependencias sobre plugins desactivados antes de procesar un solo dato.

`requires.warmupBars` evita valores de calentamiento: hasta que no hay
suficientes velas, la variable vale `null` en vez de un número que no significa
nada.

## Un plugin de variables

```ts
import { Atr, defineFeaturePlugin, type FeatureContext } from "@trf/plugin-sdk";
import type { Bar, VariableDefinition } from "@trf/shared";

const provides: VariableDefinition[] = [
  {
    key: "fvg.sizeAtr",                 // namespace.nombre, obligatorio
    label: "Tamaño del FVG (ATR)",
    description: "Amplitud del hueco dividida por el ATR.",
    valueType: "continuous",
    causality: "predictor",             // ← el campo que más importa
    unit: "atr",
    producedBy: "fair-value-gap",
    producerVersion: "1.0.0",
    binning: { kind: "quantile", count: 5 },
  },
];

const estado = new Atr(14);

export default defineFeaturePlugin<{ minSizeAtr: number }>({
  provides,

  init(ctx) { /* configuración efectiva en ctx.config */ },

  // Estado incremental: una vez por vela cerrada, O(1).
  onBar(bar: Bar) { estado.update(bar); },

  // Se invoca en el instante exacto de la entrada.
  compute(ctx: FeatureContext<{ minSizeAtr: number }>) {
    const atr = ctx.feature("volatility.atr");   // de otro plugin
    const previa = ctx.market.primary.at(1);     // 0 = última cerrada
    const hueco = /* ... */ 0;

    return {
      "fvg.sizeAtr": atr !== null && atr > 0 ? hueco / atr : null,
    };
  },

  reset() { estado.reset(); },
});
```

### Reglas

1. **`compute` no mantiene estado.** Todo lo incremental va en `onBar`.
   Recalcular una EMA200 dentro de `compute` convierte una corrida de segundos
   en una de minutos.

2. **`null` significa "desconocido", y no es lo mismo que 0.** Una EMA que aún
   no ha calentado vale `null`. En el análisis, cualquier comparación con `null`
   es falsa (igual que en SQL), así que esas filas nunca entran por accidente en
   una cohorte.

3. **Normaliza por ATR.** El NAS100 ha pasado de 12.000 a más de 20.000. Una
   variable en puntos brutos mezcla regímenes que no son comparables y produce
   patrones que "dejan de funcionar" cuando en realidad nunca existieron.

4. **Elige bien la causalidad.** Si dudas, pregúntate: *¿podría calcular esto en
   tiempo real justo antes de pulsar el botón?* Si no, es `outcome`.

## Un plugin de entrada

```ts
import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

export default defineEntryPlugin<Config>({
  onBarClose(ctx: EntryContext<Config>): readonly EntrySignal[] {
    if (ctx.market.calendar.minuteOfDay !== 570) return [];
    return [{
      direction: "long",
      takeProfitPoints: 40,
      stopLossPoints: 20,
      maxHoldMinutes: 120,
      tag: "apertura",
    }];
  },
});
```

`onBarClose` se invoca al cerrar cada vela y sus señales se abren en la
**apertura de la siguiente**. Nunca decides y entras al mismo precio.

Una recomendación de método: **haz tus reglas de entrada deliberadamente
tontas**. La regla define la *población* a estudiar; los filtros se descubren
después con el motor de análisis y se validan fuera de muestra. Si la regla ya
lleva los filtros dentro, no puedes medir cuánto aporta cada uno ni cuántas
combinaciones probaste, y entonces el p-valor deja de significar nada.

## La vista de mercado

```ts
ctx.market.now                    // instante de decisión (epoch ms)
ctx.market.calendar               // partes de fecha en la zona del MERCADO
ctx.market.primary.at(0)          // última vela CERRADA
ctx.market.primary.last(20)       // orden cronológico
ctx.market.primary.closes(50)     // Float64Array lista para indicadores
ctx.market.series("M15")          // sólo si lo declaraste en requires
ctx.market.price()                // último cierre conocido
ctx.market.dailyOpen()
ctx.market.today() / previousDay()
ctx.feature("volatility.atr")     // variable de un plugin del que dependes
```

No existe forma de pedir una vela posterior a `now`. Si el motor detecta que la
serie contiene una vela sin cerrar, lanza `LookaheadError`. La API no expone el
dato, así que el error no se puede escribir.

## Indicadores incluidos

`Ema`, `Sma`, `Atr` (Wilder, el mismo que MT5), `RollingExtremes`,
`SessionVwap`, `StreakCounter`, `RunningStats`. Todos O(1) por vela y todos con
`ready`, que evita devolver valores de calentamiento.

Ojo con el ATR: Wilder usa `alpha = 1/período`, **no** `2/(período+1)`.
Confundirlos hace que el ATR de la plataforma no cuadre con el del gráfico.

## Gestión

```bash
pnpm trf plugins:list              # detectados, estado y orden de ejecución
pnpm trf plugins:disable core-vwap
pnpm trf plugins:enable  core-vwap
```

Al activar o desactivar un plugin cambia la **huella del conjunto de features**
(`featureSetVersion`), que se guarda en cada operación. Así el sistema sabe
exactamente qué operaciones quedaron obsoletas sin recalcularlo todo.
