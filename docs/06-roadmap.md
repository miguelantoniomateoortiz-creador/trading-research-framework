# Roadmap

## Nivel 6 — Pattern Discovery

Búsqueda automática de combinaciones que cumplan criterios dados:

```
WR > 94%   ·   operaciones > 1000   ·   PF > 2   ·   DD < 5%
```

**Ya está construido lo que hace falta**: enumerar predicados y evaluar
cohortes. `analyze:marginal` produce además los cortes candidatos derivados de
los datos.

Plan de implementación (`packages/analyzer/src/discovery.ts`):

1. **Generar condiciones candidatas.** Para cada variable predictora, sus tramos
   del análisis marginal. Con 40 variables y 5 tramos → 200 condiciones simples.
2. **Búsqueda por niveles, estilo Apriori.** Empezar con condiciones simples;
   quedarse con las que superen `minCount`; combinar sólo esas en pares; repetir
   hasta la profundidad máxima (3 por defecto).
   La poda es lo que hace viable el problema: si `ATR > 18` ya deja menos de
   1.000 operaciones, ninguna conjunción que la contenga llegará a 1.000, así
   que la rama entera se descarta sin evaluarla.
3. **Reutilizar máscaras.** `intersect(maskA, maskB)` es una pasada sobre un
   `Uint8Array`; recompilar el predicado entero es varias.
4. **Contar el espacio de búsqueda.** Cada resultado debe llevar cuántas
   combinaciones se evaluaron para llegar a él, y el q-valor de Benjamini-
   Hochberg sobre ese total. Sin ese número, el motor es un generador de
   ilusiones.
5. **Filtrar por robustez, no sólo por rendimiento.** Un resultado con PF 8 y
   R² 0,3 debe ordenarse por debajo de uno con PF 2 y R² 0,95.

Interfaz prevista:

```bash
pnpm trf discover --split train \
  --min-trades 1000 --min-winrate 0.6 --min-pf 2 --max-dd-pct 0.05 \
  --max-conditions 3 --top 20
```

Criterio de aceptación: en datos sintéticos **con** patrón inyectado lo
encuentra; en datos sintéticos **sin** patrón no devuelve nada con q < 0,05.

## Nivel 7 — Validación formal

Las tablas `hypotheses` y `validation_runs` ya existen, igual que la guarda de
solapamiento y el contador de usos.

Falta:

```bash
pnpm trf hypothesis:save --name "reversión de apertura" --where "..." --from-discovery <id>
pnpm trf hypothesis:list
pnpm trf hypothesis:validate <id> --split val
```

`hypothesis:validate` debe:

- exigir confirmación explícita y mostrar cuántas veces se ha usado ese split;
- comparar el resultado con el **intervalo de confianza** del entrenamiento, no
  con su valor puntual — que el win rate baje del 68% al 64% no es un fallo si
  el IC del entrenamiento era [63%, 73%];
- escribir un `validation_run` inmutable pase lo que pase;
- marcar la hipótesis como `validated` o `rejected` y no dejar revalidarla sin
  crear una hipótesis nueva.

Extensión natural: **walk-forward**. Dividir el histórico en ventanas móviles
(entrenar en 12 meses, validar en 3, avanzar 3) y reportar la distribución de
resultados en lugar de un único número. Es más informativo que un solo split y
la infraestructura de splits ya lo soporta.

## Nivel 8 — Dashboard

Ver `apps/web/README.md` para la estructura prevista y las tres reglas que
deben respetarse para que la interfaz no erosione la arquitectura.

## Más allá

**Conexión directa con MT5.** `MarketDataSource` ya está abstraída; ver
`docs/03-importar-mt5.md` para las tres opciones evaluadas.

**Plugins pendientes**, todos encajan sin tocar el núcleo:

| Plugin | Variables que aportaría |
|---|---|
| Fair Value Gap | existencia, tamaño en ATR, distancia, antigüedad |
| Order Blocks | nivel, distancia, si ha sido mitigado |
| Liquidity Sweep | barrido de máximos/mínimos previos y su magnitud |
| Market Structure | HH/HL/LH/LL, si hay cambio de estructura |
| Price Action | envolventes, martillos, dojis, insides |
| Correlaciones | distancia del NAS100 al SPX y al VIX |
| Calendario económico | minutos hasta la próxima noticia de alto impacto |

El de calendario económico es probablemente el más valioso y el único que
necesita una fuente de datos externa.

**Escalar más allá de SQLite.** SQLite aguanta cómodamente decenas de millones
de filas con los índices actuales. Si algún día se queda corto, el sustituto
natural es DuckDB: columnar, se instala igual de fácil, lee ficheros Parquet
directamente y está pensado justo para este tipo de análisis. Sólo habría que
reescribir `packages/database/src/` — el resto del framework no se enteraría.

**Costes realistas por régimen.** Ahora el spread es un parámetro fijo. Los
datos de MT5 traen el spread por vela; usarlo en lugar de la constante haría los
resultados notablemente más honestos en las velas volátiles, que son justo
donde más se opera.
