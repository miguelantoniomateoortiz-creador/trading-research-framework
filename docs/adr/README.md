# Decisiones de arquitectura (ADR)

Cada documento registra una decisión, las alternativas que se descartaron y por
qué. Sirven para que dentro de dos años se pueda cambiar de opinión con
conocimiento de causa en lugar de deshacer algo sin saber qué problema resolvía.

| ADR | Decisión |
|---|---|
| [0001](0001-esquema-hibrido.md) | Esquema híbrido: columnas nativas + blob JSON + registro |
| [0002](0002-monorepo-paquetes-internos.md) | Monorepo pnpm con paquetes internos sin build |
| [0003](0003-prisma-mas-better-sqlite3.md) | Prisma para el esquema, better-sqlite3 para el runtime |
| [0004](0004-causalidad-de-variables.md) | Causalidad obligatoria en cada variable |

## Formato

```markdown
# ADR-000X · Título

**Estado:** propuesto | aceptado | sustituido por ADR-000Y
**Fecha:** AAAA-MM

## Contexto        ¿Qué problema hay?
## Alternativas    ¿Qué se consideró y qué falla en cada opción?
## Decisión        ¿Qué se hace?
## Consecuencias   ¿Qué se gana, qué se pierde, qué queda pendiente?
```

Una decisión se sustituye, no se borra. El historial de por qué algo *fue* una
buena idea es tan útil como la decisión actual.
