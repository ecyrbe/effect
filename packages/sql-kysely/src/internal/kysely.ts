/**
 * @since 1.0.0
 */
import * as Client from "@effect/sql/Client"
import * as Effect from "effect/Effect"
import {
  AlterTableColumnAlteringBuilder,
  CreateIndexBuilder,
  CreateSchemaBuilder,
  CreateTableBuilder,
  CreateTypeBuilder,
  CreateViewBuilder,
  DeleteQueryBuilder,
  DropIndexBuilder,
  DropSchemaBuilder,
  DropTableBuilder,
  DropTypeBuilder,
  DropViewBuilder,
  InsertQueryBuilder,
  Kysely,
  UpdateQueryBuilder,
  WheneableMergeQueryBuilder
} from "kysely"
import type { Dialect } from "kysely"
import type { EffectKysely } from "../patch.types.js"
import { effectifyWithExecute, effectifyWithSql, patch } from "./patch.js"

/**
 * @internal
 * patch all compilable/executable builders with commit prototypes
 *
 * @warning side effect
 */
patch(AlterTableColumnAlteringBuilder.prototype)
patch(CreateIndexBuilder.prototype)
patch(CreateSchemaBuilder.prototype)
patch(CreateTableBuilder.prototype)
patch(CreateTypeBuilder.prototype)
patch(CreateViewBuilder.prototype)
patch(DropIndexBuilder.prototype)
patch(DropSchemaBuilder.prototype)
patch(DropTableBuilder.prototype)
patch(DropTypeBuilder.prototype)
patch(DropViewBuilder.prototype)
patch(InsertQueryBuilder.prototype)
patch(UpdateQueryBuilder.prototype)
patch(DeleteQueryBuilder.prototype)
patch(WheneableMergeQueryBuilder.prototype)

/**
 * @internal
 */
export const makeFromSql = <DB>(dialect: Dialect) =>
  Effect.gen(function*() {
    const client = yield* Client.Client

    const db = new Kysely<DB>({ dialect }) as unknown as EffectKysely<DB>
    db.withTransaction = client.withTransaction

    // SelectQueryBuilder is not exported from "kysely" so we patch the prototype from it's instance
    const selectPrototype = Object.getPrototypeOf(db.selectFrom("" as any))
    patch(selectPrototype)

    return effectifyWithSql(db, client, ["withTransaction"])
  })

export const makeFromDialect = <DB>(dialect: Dialect) => {
  const db = new Kysely<DB>({ dialect })
  // SelectQueryBuilder is not exported from "kysely" so we patch the prototype from it's instance
  const selectPrototype = Object.getPrototypeOf(db.selectFrom("" as any))
  patch(selectPrototype)
  return effectifyWithExecute(db)
}
