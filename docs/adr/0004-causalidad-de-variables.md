# ADR-0004 · Causalidad obligatoria en cada variable

**Estado:** aceptado · **Fecha:** 2026-08

## Contexto

Esta decisión **no estaba en el encargo**. Se añadió a partir de uno de los
ejemplos del propio enunciado:

```
Hora = 9:30 AND ATR > 18 AND MAE < 25
```

Las dos primeras condiciones son legítimas. La tercera es lookahead: el MAE
(máxima excursión adversa) sólo se conoce cuando la operación ha cerrado.

Ese filtro concreto produce un win rate cercano al 95%. Es completamente
inoperable, porque a las 9:30 no sabes cuál será el MAE. Y el resultado no tiene
ningún aspecto sospechoso: es exactamente lo que uno esperaría ver si hubiera
encontrado algo extraordinario.

Es el error más caro de la investigación cuantitativa precisamente porque no
falla: mejora los números.

## Decisión

Todo `VariableDefinition` declara un campo obligatorio `causality`:

- **`predictor`** — conocida antes de decidir la entrada. Sólo estas valen para
  formular hipótesis.
- **`outcome`** — sólo se conoce al cerrar: MAE, MFE, profit, duración,
  eficiencia, motivo de salida.
- **`meta`** — identificadores y bookkeeping: año, lote de importación, id.

`assertHypothesisSafe()` lanza `LookaheadError` ante una variable `outcome`,
`meta` o no registrada. Es una barrera dura: no hay bandera para "sólo esta
vez".

Se admite `purpose: "diagnostic"`, que hay que pedir explícitamente y que el CLI
recuerda en la salida. *"¿Cómo se reparte el MAE de las operaciones que ya he
seleccionado?"* es la pregunta correcta para dimensionar un stop loss; lo que
nunca se permite es que esa respuesta se convierta en condición de entrada.

## Por qué `meta` también se bloquea

`time.year` es técnicamente conocido antes de entrar: el 3 de marzo de 2024
sabes que estás en 2024. Pero condicionar por año es memorizar el pasado, no
descubrir una regularidad. Un motor de descubrimiento con acceso al año
encontrará "patrones" del tipo *"funciona en 2023 y 2021"*, que son sobreajuste
en estado puro.

Por eso `time.year` existe (hace falta para definir splits) pero está marcado
como `meta`.

## Consecuencias

- Cada plugin debe pensar en qué categoría cae cada variable que produce.
  Es fricción deliberada: obliga a hacerse la pregunta correcta.
- Las variables de recorrido del simulador (MAE, MFE, velocidad, retrocesos)
  siguen siendo valiosas — para diseñar salidas, no entradas.
- El nivel 6 sólo enumera `predictor`, lo que además **reduce el espacio de
  búsqueda** y con él el problema de multiplicidad.
- Regla mnemotécnica para autores de plugins: *¿podría calcular esto en tiempo
  real justo antes de pulsar el botón?* Si no, es `outcome`.
