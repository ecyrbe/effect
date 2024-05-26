import * as Array from "effect/Array"
import * as Cause from "effect/Cause"
import * as CircuitBreaker from "effect/CircuitBreaker"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Metric from "effect/Metric"
import * as MetricLabel from "effect/MetricLabel"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Random from "effect/Random"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as it from "effect/test/utils/extend"
import * as TestClock from "effect/TestClock"
import { describe, expect } from "vitest"

type DomainError = FatalError | NonFatalError
class FatalError extends Data.TaggedError("FatalError") {}
class NonFatalError extends Data.TaggedError("NonFatalError") {}

const isFailure = (error: DomainError): boolean => Predicate.isTagged(error, "FatalError")

describe("CircuitBreaker", () => {
  it.scoped("lets successful calls through", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 10,
        resetPolicy: Schedule.exponential("1 second")
      }))
      yield* _(cb(Effect.void), Effect.repeat(Schedule.recurs(20)))
      expect.anything()
    }))

  it.scoped("fails fast after failure limit is reached", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 100,
        resetPolicy: Schedule.exponential("1 second")
      }))
      yield* _(Effect.forEach(
        Array.range(1, 105),
        () => cb(Effect.fail(new FatalError()).pipe(Effect.either)),
        { concurrency: "unbounded", discard: true }
      ))
      const result = yield* _(Effect.either(cb(Effect.fail(new FatalError()))))
      expect(result).toEqual(Either.left({
        _tag: "WrappedError",
        error: new FatalError()
      }))
    }))

  it.scoped("ignore failures that should not be considered a failure", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures<DomainError>({
        maxFailures: 3,
        resetPolicy: Schedule.exponential("1 second"),
        isFailure
      }))
      yield* _(
        cb(Effect.fail(new NonFatalError())),
        Effect.either,
        Effect.repeatN(3)
      )
      const result = yield* _(Effect.either(Effect.fail(new FatalError())))
      expect(result).toEqual(Either.left(new FatalError()))
    }))

  it.scoped("reset to closed state after reset timeout", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 10,
        resetPolicy: Schedule.exponential("1 second")
      }))
      const queue = yield* _(cb.stateChanges)
      const states = yield* _(Queue.unbounded<CircuitBreaker.CircuitBreaker.State>())
      yield* _(
        Stream.fromQueue(queue),
        Stream.map(({ to }) => to),
        Stream.tap((state) => Queue.offer(states, state)),
        Stream.runDrain,
        Effect.forkScoped
      )
      yield* _(Effect.forEach(
        Array.range(1, 10),
        () => Effect.either(cb(Effect.fail(new FatalError()))),
        { discard: true }
      ))
      const s1 = yield* _(Queue.take(states))
      yield* _(TestClock.adjust("3 seconds"))
      const s2 = yield* _(Queue.take(states))
      yield* _(cb(Effect.void))
      const s3 = yield* _(Queue.take(states))
      expect(s1).toBe("Open")
      expect(s2).toBe("HalfOpen")
      expect(s3).toBe("Closed")
    }))

  it.scoped("retry exponentially", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 3,
        resetPolicy: Schedule.exponential("1 second", 2)
      }))
      const queue = yield* _(cb.stateChanges)
      const states = yield* _(Queue.unbounded<CircuitBreaker.CircuitBreaker.State>())
      yield* _(
        Stream.fromQueue(queue),
        Stream.map(({ to }) => to),
        Stream.tap((state) => Queue.offer(states, state)),
        Stream.runDrain,
        Effect.forkScoped
      )
      yield* _(Effect.forEach(
        Array.range(1, 3),
        () => Effect.either(cb(Effect.fail(new FatalError()))),
        { discard: true }
      ))
      const s1 = yield* _(Queue.take(states)) // Open
      yield* _(TestClock.adjust("1 second"))
      const s2 = yield* _(Queue.take(states)) // HalfOpen
      yield* _(Effect.either(cb(new FatalError())))
      const s3 = yield* _(Queue.take(states)) // Open Again
      const s4 = yield* _(
        Queue.take(states),
        Effect.timeout("1 second"),
        Effect.zipLeft(TestClock.adjust("1 second"), { concurrent: true }),
        Effect.flip
      )
      yield* _(TestClock.adjust("1 second"))
      const s5 = yield* _(Queue.take(states))
      yield* _(cb(Effect.void))
      const s6 = yield* _(Queue.take(states))
      expect(s1).toBe("Open")
      expect(s2).toBe("HalfOpen")
      expect(s3).toBe("Open")
      expect(s4).toEqual(new Cause.TimeoutException())
      expect(s5).toBe("HalfOpen")
      expect(s6).toBe("Closed")
    }))

  it.scoped("reset the exponential timeout after a Closed->Open->HalfOpen->Closed", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 3,
        resetPolicy: Schedule.exponential("1 second", 2)
      }))
      const queue = yield* _(cb.stateChanges)
      const states = yield* _(Queue.unbounded<CircuitBreaker.CircuitBreaker.State>())
      yield* _(
        Stream.fromQueue(queue),
        Stream.map(({ to }) => to),
        Stream.tap((state) => Queue.offer(states, state)),
        Stream.runDrain,
        Effect.forkScoped
      )
      yield* _(Effect.forEach(
        Array.range(1, 3),
        () => Effect.either(cb(Effect.fail(new FatalError()))),
        { discard: true }
      ))
      const s1 = yield* _(Queue.take(states))
      yield* _(TestClock.adjust("1 second"))
      const s2 = yield* _(Queue.take(states))
      yield* _(Effect.either(cb(Effect.fail(new FatalError()))))
      const s3 = yield* _(Queue.take(states))
      yield* _(TestClock.adjust("2 seconds"))
      const s4 = yield* _(Queue.take(states))
      yield* _(cb(Effect.void))
      const s5 = yield* _(Queue.take(states))
      yield* _(Effect.forEach(
        Array.range(1, 3),
        () => Effect.either(cb(Effect.fail(new FatalError()))),
        { discard: true }
      ))
      const s6 = yield* _(Queue.take(states))
      yield* _(TestClock.adjust("1 second"))
      const s7 = yield* _(Queue.take(states))
      expect(s1).toBe("Open")
      expect(s2).toBe("HalfOpen")
      expect(s3).toBe("Open")
      expect(s4).toBe("HalfOpen")
      expect(s5).toBe("Closed")
      expect(s6).toBe("Open")
      expect(s7).toBe("HalfOpen")
    }))

  it.scoped("reset to Closed after HalfOpen on success", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 5,
        resetPolicy: Schedule.exponential("2 seconds"),
        isFailure
      }))
      const ref = yield* _(Ref.make(0))
      const error1 = yield* _(Effect.flip(cb(Effect.fail(new NonFatalError()))))
      const errors = yield* _(
        cb(Effect.fail(new FatalError())),
        Effect.flip,
        Effect.replicateEffect(5)
      )
      yield* _(TestClock.adjust("1 second"))
      const error3 = yield* _(Effect.flip(cb(Ref.update(ref, (n) => n + 1))))
      yield* _(TestClock.adjust("1 second"))
      yield* _(cb(Ref.update(ref, (n) => n + 1)))
      yield* _(cb(Ref.update(ref, (n) => n + 1)))
      const calls = yield* _(Ref.get(ref))
      expect(error1).toEqual({
        _tag: "WrappedError",
        error: new NonFatalError()
      })
      expect(errors).toEqual(Array.replicate({
        _tag: "WrappedError",
        error: new FatalError()
      }, 5))
      expect(error3).toEqual({ _tag: "OpenError" })
      expect(calls).toBe(2)
    }))

  it.scoped("reset to Closed after HalfOpen on error if isFailure is false", () =>
    Effect.gen(function*(_) {
      const cb = yield* _(CircuitBreaker.withMaxFailures({
        maxFailures: 5,
        resetPolicy: Schedule.exponential("2 seconds"),
        isFailure
      }))
      const ref = yield* _(Ref.make(0))
      const errors = yield* _(
        cb(Effect.fail(new FatalError())),
        Effect.flip,
        Effect.replicateEffect(5)
      )
      yield* _(TestClock.adjust("1 second"))
      const error1 = yield* _(Effect.flip(cb(Ref.update(ref, (n) => n + 1))))
      yield* _(TestClock.adjust("1 second"))
      const error2 = yield* _(Effect.flip(cb(Effect.fail(new NonFatalError()))))
      yield* _(cb(Ref.update(ref, (n) => n + 1)))
      const calls = yield* _(Ref.get(ref))
      expect(errors).toEqual(Array.replicate({
        _tag: "WrappedError",
        error: new FatalError()
      }, 5))
      expect(error1).toEqual({ _tag: "OpenError" })
      expect(error2).toEqual({
        _tag: "WrappedError",
        error: new NonFatalError()
      })
      expect(calls).toBe(1)
    }))

  describe("metrics", () => {
    it.scoped("has suitable initial metric values", () =>
      Effect.gen(function*(_) {
        const labels = yield* _(
          Random.nextInt,
          Effect.map((id) => [MetricLabel.make("test_id", id.toString())])
        )
        yield* _(CircuitBreaker.withMaxFailures({
          maxFailures: 3,
          metricLabels: labels
        }))
        const metricState = yield* _(
          Metric.gauge("effect_circuit_breaker_state"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        const metricStateChanges = yield* _(
          Metric.counter("effect_circuit_breaker_state_changes"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        const metricSuccesses = yield* _(
          Metric.counter("effect_circuit_breaker_successful_calls"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        const metricFailures = yield* _(
          Metric.counter("effect_circuit_breaker_failed_calls"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        const metricRejections = yield* _(
          Metric.counter("effect_circuit_breaker_rejected_calls"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        expect(metricState.value).toEqual(0)
        expect(metricStateChanges.count).toBe(0)
        expect(metricSuccesses.count).toBe(0)
        expect(metricFailures.count).toBe(0)
        expect(metricRejections.count).toBe(0)
      }))

    it.scoped("tracks successful and failed calls", () =>
      Effect.gen(function*(_) {
        const labels = yield* _(
          Random.nextInt,
          Effect.map((id) => [MetricLabel.make("test_id", id.toString())])
        )
        const cb = yield* _(CircuitBreaker.withMaxFailures({
          maxFailures: 3,
          metricLabels: labels
        }))
        yield* _(cb(Effect.void))
        yield* _(Effect.either(cb(Effect.fail("failed"))))
        const metricSuccesses = yield* _(
          Metric.counter("effect_circuit_breaker_successful_calls"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        const metricFailures = yield* _(
          Metric.counter("effect_circuit_breaker_failed_calls"),
          Metric.taggedWithLabels(labels),
          Metric.value
        )
        expect(metricSuccesses.count).toBe(1)
        expect(metricFailures.count).toBe(1)
      }))

    it.scoped("records state changes", () =>
      Effect.gen(function*(_) {
        const labels = yield* _(
          Random.nextInt,
          Effect.map((id) => [MetricLabel.make("test_id", id.toString())])
        )
        const cb = yield* _(CircuitBreaker.withMaxFailures({
          maxFailures: 10,
          metricLabels: labels,
          resetPolicy: Schedule.exponential("1 second")
        }))
        const metricState = Metric.gauge("effect_circuit_breaker_state").pipe(
          Metric.taggedWithLabels(labels)
        )
        const metricStateChanges = Metric.counter("effect_circuit_breaker_state_changes").pipe(
          Metric.taggedWithLabels(labels)
        )
        yield* _(Effect.forEach(
          Array.range(1, 10),
          () => Effect.either(cb(Effect.fail(new FatalError()))),
          { discard: true }
        ))
        yield* _(TestClock.adjust("0 second"))
        const stateAfterFailures = yield* _(Metric.value(metricState))
        yield* _(TestClock.adjust("1 second"))
        const stateAfterReset = yield* _(Metric.value(metricState))
        yield* _(TestClock.adjust("1 second"))
        yield* _(cb(Effect.void))
        yield* _(TestClock.adjust("1 second"))
        const stateChanges = yield* _(Metric.value(metricStateChanges))
        const stateFinal = yield* _(Metric.value(metricState))
        expect(stateChanges.count).toBe(3)
        expect(stateAfterFailures.value).toBe(2)
        expect(stateAfterReset.value).toBe(1)
        expect(stateFinal.value).toBe(0)
      }))
  })
})
