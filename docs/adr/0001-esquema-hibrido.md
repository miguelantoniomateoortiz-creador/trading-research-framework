# ADR-0001 · Esquema híbrido para variables dinámicas

**Estado:** aceptado · **Fecha:** 2026-08

## Contexto

Requisitos en tensión: la base debe soportar millones de operaciones y permitir
añadir variables nuevas sin migrar el esquema ni tocar el núcleo.

## Alternativas

### A · EAV — `trade_features(trade_id, key, value)`

- ✅ Flexibilidad total, cero migraciones.
- ❌ 10M operaciones × 80 variables = 800M de filas.
- ❌ Cada condición del predicado es un self-join. Tres condiciones = tres joins
  sobre cientos de millones de filas.
- ❌ Un análisis marginal sobre 40 variables se vuelve inviable.

### B · `ALTER TABLE` por variable

- ✅ Lectura óptima, índices nativos.
- ❌ Cada plugin nuevo migra el esquema y bloquea la tabla.
- ❌ Rompe el requisito explícito de no tocar el núcleo al añadir una idea.
- ❌ Desinstalar un plugin deja columnas huérfanas para siempre.

### C · Híbrido (elegido)

Columnas nativas para lo que se consulta en todos los análisis + blob JSON para
las variables de plugins + tabla `variable_definitions` que da semántica al blob
+ materialización opcional a columna generada con índice.

- ✅ Sin migraciones al añadir un plugin.
- ✅ Las consultas frecuentes van por columna nativa indexada.
- ✅ El blob no es opaco: el registro le da tipo, unidad, causalidad y
  procedencia.
- ✅ Camino de optimización sin reescribir datos.
- ⚠️ Dos sitios donde puede vivir una variable → el analizador debe resolver
  cuál usar. Se encapsula en `resolveFeatureExpression()`, y nada más en el
  sistema necesita saberlo.
- ⚠️ El JSON ocupa más que columnas nativas. Medido: ~90 bytes por operación con
  30 variables. Con 10M de operaciones son 900 MB, asumible.

## Decisión

Opción C.

## Consecuencias

- Añadir un plugin no toca la base de datos.
- `trf variables:materialize --key X` convierte una variable en indexada cuando
  se demuestra caliente.
- Si el volumen creciera un orden de magnitud, la migración natural es DuckDB,
  que lee este mismo modelo sin cambios conceptuales.
