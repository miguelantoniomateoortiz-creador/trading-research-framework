/**
 * DDL ejecutable directamente sobre SQLite.
 *
 * ¿Por qué existe si ya hay un schema.prisma? Porque los tests y el CLI deben
 * poder crear una base desde cero sin depender de `prisma generate` ni de un
 * cliente generado. `applySchema()` es idempotente (`IF NOT EXISTS`).
 *
 * FUENTE DE VERDAD: `prisma/schema.prisma`. Este fichero debe mantenerse
 * sincronizado; para regenerarlo:
 *
 *   pnpm --filter @trf/database exec prisma migrate diff \
 *     --from-empty --to-schema-datamodel prisma/schema.prisma --script
 *
 * `pnpm db:check-ddl` compara ambos y falla si divergen.
 */

export const SCHEMA_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS "instruments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "symbol" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "sessionTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "tickSize" REAL NOT NULL DEFAULT 0.1,
  "pointValue" REAL NOT NULL DEFAULT 1,
  "regularSessionOpenMinute" INTEGER NOT NULL DEFAULT 570,
  "regularSessionCloseMinute" INTEGER NOT NULL DEFAULT 960,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "instruments_symbol_key" ON "instruments"("symbol");

CREATE TABLE IF NOT EXISTS "bars" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "instrumentId" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "ts" REAL NOT NULL,
  "open" REAL NOT NULL,
  "high" REAL NOT NULL,
  "low" REAL NOT NULL,
  "close" REAL NOT NULL,
  "tickVolume" REAL NOT NULL DEFAULT 0,
  "volume" REAL NOT NULL DEFAULT 0,
  "spread" REAL NOT NULL DEFAULT 0,
  CONSTRAINT "bars_instrumentId_fkey" FOREIGN KEY ("instrumentId")
    REFERENCES "instruments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "bars_instrumentId_timeframe_ts_key"
  ON "bars"("instrumentId", "timeframe", "ts");

CREATE TABLE IF NOT EXISTS "entry_rules" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pluginId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "configJson" TEXT NOT NULL DEFAULT '{}',
  "fingerprint" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "entry_rules_fingerprint_key" ON "entry_rules"("fingerprint");

CREATE TABLE IF NOT EXISTS "import_batches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "instrumentId" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "sourceFile" TEXT NOT NULL DEFAULT '',
  "sourceHash" TEXT NOT NULL DEFAULT '',
  "rowsRead" INTEGER NOT NULL DEFAULT 0,
  "rowsAccepted" INTEGER NOT NULL DEFAULT 0,
  "rowsRejected" INTEGER NOT NULL DEFAULT 0,
  "errorsJson" TEXT NOT NULL DEFAULT '[]',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  CONSTRAINT "import_batches_instrumentId_fkey" FOREIGN KEY ("instrumentId")
    REFERENCES "instruments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "import_batches_instrumentId_startedAt_idx"
  ON "import_batches"("instrumentId", "startedAt");

CREATE TABLE IF NOT EXISTS "trades" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "instrumentId" TEXT NOT NULL,
  "entryRuleId" TEXT NOT NULL,
  "importBatchId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'simulated',
  "direction" TEXT NOT NULL,
  "entryTs" REAL NOT NULL,
  "exitTs" REAL NOT NULL,
  "entryPrice" REAL NOT NULL,
  "exitPrice" REAL NOT NULL,
  "takeProfitPrice" REAL,
  "stopLossPrice" REAL,
  "pnlPoints" REAL NOT NULL,
  "pnlMoney" REAL NOT NULL,
  "volumeLots" REAL NOT NULL DEFAULT 1,
  "exitReason" TEXT NOT NULL DEFAULT 'unknown',
  "durationMinutes" REAL NOT NULL,
  "mae" REAL NOT NULL DEFAULT 0,
  "mfe" REAL NOT NULL DEFAULT 0,
  "minutesToMae" REAL NOT NULL DEFAULT 0,
  "minutesToMfe" REAL NOT NULL DEFAULT 0,
  "maxSpeedPointsPerMin" REAL NOT NULL DEFAULT 0,
  "slopePointsPerMin" REAL NOT NULL DEFAULT 0,
  "pullbackCount" INTEGER NOT NULL DEFAULT 0,
  "efficiency" REAL NOT NULL DEFAULT 0,
  "sessionDate" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "dayOfMonth" INTEGER NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "hour" INTEGER NOT NULL,
  "minute" INTEGER NOT NULL,
  "minuteOfDay" INTEGER NOT NULL,
  "features" TEXT NOT NULL DEFAULT '{}',
  "featureSetVersion" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trades_instrumentId_fkey" FOREIGN KEY ("instrumentId")
    REFERENCES "instruments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trades_entryRuleId_fkey" FOREIGN KEY ("entryRuleId")
    REFERENCES "entry_rules" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trades_importBatchId_fkey" FOREIGN KEY ("importBatchId")
    REFERENCES "import_batches" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "trades_instrumentId_entryTs_idx" ON "trades"("instrumentId", "entryTs");
CREATE INDEX IF NOT EXISTS "trades_entryRuleId_entryTs_idx" ON "trades"("entryRuleId", "entryTs");
CREATE INDEX IF NOT EXISTS "trades_instrumentId_sessionDate_idx" ON "trades"("instrumentId", "sessionDate");
CREATE INDEX IF NOT EXISTS "trades_minuteOfDay_idx" ON "trades"("minuteOfDay");
CREATE INDEX IF NOT EXISTS "trades_featureSetVersion_idx" ON "trades"("featureSetVersion");

CREATE TABLE IF NOT EXISTS "variable_definitions" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "valueType" TEXT NOT NULL,
  "causality" TEXT NOT NULL,
  "unit" TEXT NOT NULL DEFAULT '',
  "producedBy" TEXT NOT NULL,
  "producerVersion" TEXT NOT NULL,
  "categoriesJson" TEXT,
  "binningJson" TEXT,
  "rangeJson" TEXT,
  "materialized" BOOLEAN NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "variable_definitions_producedBy_idx" ON "variable_definitions"("producedBy");
CREATE INDEX IF NOT EXISTS "variable_definitions_causality_idx" ON "variable_definitions"("causality");

CREATE TABLE IF NOT EXISTS "plugin_installs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "version" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "author" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "directory" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT 1,
  "configJson" TEXT NOT NULL DEFAULT '{}',
  "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "dataset_splits" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "startTs" REAL NOT NULL,
  "endTs" REAL NOT NULL,
  "embargoDays" INTEGER NOT NULL DEFAULT 5,
  "description" TEXT NOT NULL DEFAULT '',
  "evaluationCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dataset_splits_instrumentId_fkey" FOREIGN KEY ("instrumentId")
    REFERENCES "instruments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_splits_instrumentId_name_key"
  ON "dataset_splits"("instrumentId", "name");
CREATE INDEX IF NOT EXISTS "dataset_splits_instrumentId_role_idx" ON "dataset_splits"("instrumentId", "role");

CREATE TABLE IF NOT EXISTS "hypotheses" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "predicateJson" TEXT NOT NULL,
  "variablesJson" TEXT NOT NULL DEFAULT '[]',
  "criteriaJson" TEXT NOT NULL DEFAULT '{}',
  "trainingMetricsJson" TEXT NOT NULL DEFAULT '{}',
  "searchSpaceSize" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "hypotheses_status_idx" ON "hypotheses"("status");

CREATE TABLE IF NOT EXISTS "validation_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hypothesisId" TEXT NOT NULL,
  "splitId" TEXT NOT NULL,
  "metricsJson" TEXT NOT NULL DEFAULT '{}',
  "pValue" REAL,
  "qValue" REAL,
  "passed" BOOLEAN NOT NULL DEFAULT 0,
  "notes" TEXT NOT NULL DEFAULT '',
  "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "validation_runs_hypothesisId_fkey" FOREIGN KEY ("hypothesisId")
    REFERENCES "hypotheses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "validation_runs_splitId_fkey" FOREIGN KEY ("splitId")
    REFERENCES "dataset_splits" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "validation_runs_hypothesisId_ranAt_idx"
  ON "validation_runs"("hypothesisId", "ranAt");
`;

export const SCHEMA_VERSION = 1;
