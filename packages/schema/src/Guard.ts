/**
 * @since 1.0.0
 */

import { pipe } from "@fp-ts/data/Function"
import * as O from "@fp-ts/data/Option"
import { isString } from "@fp-ts/data/String"
import type * as AST from "@fp-ts/schema/AST"
import * as UnknownObject from "@fp-ts/schema/data/UnknownObject"
import * as I from "@fp-ts/schema/internal/common"
import type { Provider } from "@fp-ts/schema/Provider"
import { empty, findHandler, Semigroup } from "@fp-ts/schema/Provider"
import type { Schema } from "@fp-ts/schema/Schema"

/**
 * @since 1.0.0
 */
export const GuardId = I.GuardId

/**
 * @since 1.0.0
 */
export interface Guard<A> extends Schema<A> {
  readonly is: (input: unknown) => input is A
}

/**
 * @since 1.0.0
 */
export const make: <A>(schema: Schema<A>, is: Guard<A>["is"]) => Guard<A> = I.makeGuard

/**
 * @since 1.0.0
 */
export const provideGuardFor = (provider: Provider) =>
  <A>(schema: Schema<A>): Guard<A> => {
    const go = (ast: AST.AST): Guard<any> => {
      switch (ast._tag) {
        case "Declaration": {
          const handler = pipe(
            ast.provider,
            Semigroup.combine(provider),
            findHandler(I.GuardId, ast.id)
          )
          if (O.isSome(handler)) {
            return O.isSome(ast.config) ?
              handler.value(ast.config.value)(...ast.nodes.map(go)) :
              handler.value(...ast.nodes.map(go))
          }
          throw new Error(
            `Missing support for Guard compiler, data type ${String(ast.id.description)}`
          )
        }
        case "LiteralType":
          return make(I.makeSchema(ast), (u): u is any => u === ast.literal)
        case "UndefinedKeyword":
          return _undefined
        case "NeverKeyword":
          return _never as any
        case "UnknownKeyword":
          return _unknown
        case "AnyKeyword":
          return _any
        case "StringKeyword":
          return _string
        case "Tuple":
          return _tuple(
            ast,
            ast.components.map((c) => go(c.value)),
            pipe(ast.restElement, O.map(go))
          )
        case "Struct":
          return _struct(
            ast,
            ast.fields.map((f) => go(f.value)),
            pipe(ast.indexSignatures.string, O.map((is) => go(is.value))),
            pipe(ast.indexSignatures.symbol, O.map((is) => go(is.value)))
          )
        case "Union": {
          const members = ast.members.map(go)
          return make(
            I.makeSchema(ast),
            (a): a is any => members.some((guard) => guard.is(a))
          )
        }
        case "Lazy":
          return _lazy(() => go(ast.f()))
      }
    }

    return go(schema.ast)
  }

/**
 * @since 1.0.0
 */
export const guardFor: <A>(schema: Schema<A>) => Guard<A> = provideGuardFor(empty)

const _undefined: Guard<undefined> = make(
  I.undefinedKeyword,
  I.isUndefined
)

const _never = make(I.neverKeyword, I.isNever)

const _unknown = make(I.unknownKeyword, I.isUnknown)

const _any = make(I.anyKeyword, I.isUnknown)

const _string = make(I.stringKeyword, isString)

const _tuple = (
  ast: AST.Tuple,
  components: ReadonlyArray<Guard<any>>,
  oRestElement: O.Option<Guard<any>>
): Guard<any> =>
  make(
    I.makeSchema(ast),
    (input: unknown): input is any => {
      if (!Array.isArray(input)) {
        return false
      }
      let i = 0
      // ---------------------------------------------
      // handle components
      // ---------------------------------------------
      for (; i < components.length; i++) {
        // ---------------------------------------------
        // handle optional components
        // ---------------------------------------------
        if (ast.components[i].optional && input[i] === undefined) {
          continue
        }
        if (!components[i].is(input[i])) {
          return false
        }
      }
      // ---------------------------------------------
      // handle rest element
      // ---------------------------------------------
      if (O.isSome(oRestElement)) {
        const guard = oRestElement.value
        for (; i < input.length; i++) {
          if (!guard.is(input[i])) {
            return false
          }
        }
      }

      return true
    }
  )

const _struct = (
  ast: AST.Struct,
  fields: ReadonlyArray<Guard<any>>,
  oStringIndexSignature: O.Option<Guard<any>>,
  oSymbolIndexSignature: O.Option<Guard<any>>
): Guard<any> =>
  make(
    I.makeSchema(ast),
    (input: unknown): input is any => {
      if (!UnknownObject.Guard.is(input)) {
        return false
      }
      // ---------------------------------------------
      // handle fields
      // ---------------------------------------------
      for (let i = 0; i < fields.length; i++) {
        const field = ast.fields[i]
        const key = field.key
        // ---------------------------------------------
        // handle optional fields
        // ---------------------------------------------
        const optional = field.optional
        if (optional) {
          if (!Object.prototype.hasOwnProperty.call(input, key)) {
            continue
          }
          if (input[key] === undefined) {
            continue
          }
        }
        // ---------------------------------------------
        // handle required fields
        // ---------------------------------------------
        const guard = fields[i]
        if (!guard.is(input[key])) {
          return false
        }
      }
      // ---------------------------------------------
      // handle index signatures
      // ---------------------------------------------
      const keys = Object.keys(input)
      const symbols = Object.getOwnPropertySymbols(input)
      if (O.isSome(oStringIndexSignature) || O.isSome(oSymbolIndexSignature)) {
        if (O.isSome(oStringIndexSignature)) {
          if (symbols.length > 0) {
            return false
          }
          const guard = oStringIndexSignature.value
          for (const key of keys) {
            if (!guard.is(input[key])) {
              return false
            }
          }
        }
        if (O.isSome(oSymbolIndexSignature)) {
          if (keys.length > 0) {
            return false
          }
          const guard = oSymbolIndexSignature.value
          for (const key of symbols) {
            if (!guard.is(input[key])) {
              return false
            }
          }
        }
      }

      return true
    }
  )

const _lazy = <A>(
  f: () => Guard<A>
): Guard<A> => {
  const get = I.memoize<void, Guard<A>>(f)
  const schema = I.lazy(f)
  return make(
    schema,
    (a): a is A => get().is(a)
  )
}