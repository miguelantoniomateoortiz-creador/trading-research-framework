# ADR-0003 · Prisma para el esquema, better-sqlite3 para el runtime

**Estado:** aceptado · **Fecha:** 2026-08

## Contexto

Se pidió SQLite con Prisma como ORM. Prisma es excelente definiendo esquemas,
generando migraciones y dando tipos, pero su cliente tiene dos límites que
chocan de frente con este proyecto:

1. **No hay streaming.** `findMany` materializa el resultado completo. Recorrer
   cinco años de M1 (≈ 2M de velas) devolvería un array de dos millones de
   objetos.
2. **Inserción por lotes lenta.** `createMany` sobre SQLite no aprovecha
   sentencias preparadas reutilizadas ni permite controlar la transacción con la
   granularidad que necesita una importación de cientos de MB.

Añadido: Prisma no expone PRAGMAs, ni `EXPLAIN QUERY PLAN`, ni las funciones
JSON1 que necesita el esquema híbrido (ADR-0001).

## Decisión

Las dos herramientas, cada una donde es mejor:

| Responsabilidad | Herramienta |
|---|---|
| Definición del esquema | `prisma/schema.prisma` (fuente de verdad) |
| Migraciones y versionado | Prisma Migrate |
| Inspección visual | Prisma Studio |
| Ingesta masiva | better-sqlite3 + transacciones |
| Recorridos largos | better-sqlite3 `iterate()` |
| Proyección columnar | better-sqlite3 con SQL generado |
| PRAGMAs y materialización | better-sqlite3 |

Ambas apuntan al mismo fichero `.db`.

## Por qué better-sqlite3 y no `node:sqlite` o `sql.js`

- Es **síncrono**, sin coste de promesas en bucles de millones de iteraciones.
- `transaction()` nativo: un lote en una transacción va 10-50× más rápido que
  fila a fila con autocommit.
- `iterate()` devuelve filas de una en una sin materializar el resultado. Es
  exactamente lo que cumple "no cargar toda la base en memoria".
- Maduro y estable desde hace años.

## Riesgo asumido

Dos definiciones del esquema: `schema.prisma` y el DDL de `src/ddl.ts` (que
existe para que los tests y `trf db:init` levanten una base sin depender del
cliente generado).

Mitigación: `schema.prisma` es la fuente de verdad y el DDL se regenera con

```bash
pnpm --filter @trf/database exec prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

Es la deuda consciente de esta decisión. A cambio, los tests corren sin
`prisma generate` y el arranque del proyecto no depende de un paso de
generación de código.
