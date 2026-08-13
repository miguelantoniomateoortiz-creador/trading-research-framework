# Modelo de datos

## El problema

Pediste una base preparada para millones de operaciones **y** que permita añadir
variables dinámicamente. Esas dos cosas tiran en direcciones opuestas.

## Las tres soluciones posibles

### EAV (una fila por variable y operación)

```sql
trade_features(trade_id, variable_key, value)
```

Flexibilidad total. Pero 10M de operaciones × 80 variables = **800 millones de
filas**, y cada consulta con tres condiciones necesita tres self-joins. La
consulta "hora = 570 y ATR > 18 y gap < 10" pasa de milisegundos a decenas de
segundos. Descartado.

### `ALTER TABLE` por variable

Rapidísimo de leer. Pero cada plugin nuevo migra el esquema, SQLite bloquea la
tabla durante la operación y se rompe la premisa del proyecto: *"no quiero
modificar el código principal cada vez que agregue una idea"*. Descartado.

### Híbrido — el elegido

```
columnas nativas   →  lo que se consulta en TODOS los análisis
blob JSON          →  las variables que aportan los plugins
tabla de registro  →  qué significa cada clave del blob
materialización    →  columna generada + índice para las claves calientes
```

## Columnas nativas

Viven en columnas reales de `trades`, con índices:

- **Identidad**: `id`, `instrumentId`, `entryRuleId`, `importBatchId`, `source`
- **Operación**: `direction`, `entryTs`, `exitTs`, precios, `pnlPoints`,
  `pnlMoney`, `exitReason`, `durationMinutes`
- **Recorrido**: `mae`, `mfe`, `minutesToMae`, `minutesToMfe`,
  `maxSpeedPointsPerMin`, `slopePointsPerMin`, `pullbackCount`, `efficiency`
- **Calendario**: `sessionDate`, `year`, `month`, `dayOfMonth`, `dayOfWeek`,
  `hour`, `minute`, `minuteOfDay`

El calendario está desnormalizado a propósito. Son los filtros más usados y
derivarlos en cada consulta cuesta órdenes de magnitud.

Sobre los timestamps: se guardan como `REAL`, no como `INTEGER`. El `Int` de
Prisma es de 32 bits y se desborda con epoch en milisegundos; `BigInt`
obligaría a convertir en cada lectura. Un `double` representa exactamente
cualquier entero por debajo de 2⁵³, así que no hay pérdida.

## El blob y su registro

```
trades.features = '{"volatility.atr": 18.4, "nas100.impulseDirection": 1}'
```

El blob no es un agujero negro porque `variable_definitions` describe cada
clave: etiqueta, descripción, tipo de valor, **causalidad**, unidad, plugin que
la produce, versión, categorías y binning sugerido.

Sin ese registro, el blob serían números sin significado. Con él, el analizador
sabe que `nas100.impulseDirection` es categórica con tres valores, que
`volatility.atr` se debe trocear por cuantiles y que `mae` no puede aparecer en
una hipótesis.

Las claves siguen el formato `namespace.nombre`. El namespace evita colisiones
entre plugins de terceros y el registro rechaza dos plugins que produzcan la
misma clave.

## Materialización

El blob es flexible pero `json_extract` en un `WHERE` obliga a escanear la
tabla: con 5M de operaciones, entre 2 y 4 segundos por filtro.

```bash
pnpm trf variables:materialize --key volatility.atr
```

Añade una columna generada **virtual** y la indexa:

```sql
ALTER TABLE trades ADD COLUMN mv_volatility_atr REAL
  GENERATED ALWAYS AS (json_extract(features, '$."volatility.atr"')) VIRTUAL;
CREATE INDEX idx_mv_volatility_atr ON trades(mv_volatility_atr);
```

Virtual significa que el valor no se duplica en disco; el índice sí se
materializa, y es lo que hace falta. El analizador resuelve automáticamente si
usar la columna o el `json_extract`, así que nada más en el sistema tiene que
enterarse.

Resultado: esquema flexible por defecto, rendimiento de columna nativa donde
hace falta, sin migrar ni reescribir datos.

## Las otras tablas

| Tabla | Para qué |
|---|---|
| `instruments` | Símbolo, zona horaria del mercado, minutos de sesión, valor del punto |
| `bars` | Velas M1. Clave natural `(instrumento, timeframe, ts)` → importación idempotente |
| `entry_rules` | Plugin de entrada + configuración concreta, con huella hash |
| `import_batches` | Trazabilidad: hash del fichero, filas leídas/aceptadas/rechazadas, errores |
| `variable_definitions` | El registro descrito arriba |
| `plugin_installs` | Estado y configuración de cada plugin |
| `dataset_splits` | Periodos de entrenamiento/validación, con embargo y contador de usos |
| `hypotheses` | Predicado, criterios exigidos, métricas de entrenamiento, tamaño del espacio de búsqueda |
| `validation_runs` | Cuaderno de laboratorio inmutable |

Dos campos que parecen menores y no lo son:

- **`hypotheses.searchSpaceSize`**: cuántas combinaciones se probaron para
  encontrar esa hipótesis. Sin ese número, su p-valor no significa nada.
- **`dataset_splits.evaluationCount`**: cuántas veces se ha mirado ese periodo.
  Un split de validación usado treinta veces ya no es fuera de muestra.

## PRAGMAs

```sql
journal_mode = WAL          -- lectores y escritor concurrentes
synchronous  = NORMAL       -- seguro ante caída del proceso; mucho más rápido
cache_size   = -262144      -- 256 MB de caché de páginas
mmap_size    = 268435456    -- lecturas por mapeo de memoria
temp_store   = MEMORY       -- ORDER BY grandes sin tocar disco
foreign_keys = ON
```

Sin WAL, el dashboard se bloquea mientras corre una importación. Con
`synchronous = NORMAL` en modo WAL sólo un corte de corriente puede perder la
última transacción, y a cambio la ingesta va varias veces más rápida.
