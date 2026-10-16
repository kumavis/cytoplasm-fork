// The intrinsics collector.
//
// This belongs with the reachability suite rather than beside it: the primordial
// list is part of the isolation boundary. Anything missing from it gets wrapped,
// and a wrapped primordial has a different identity on each side of the
// membrane, so `[] instanceof Array` and every builtin that checks an internal
// slot start disagreeing across the boundary.
//
// The collector replaced a vendored fork of SES's machinery. That fork is gone,
// so these assertions establish the identities independently - each anonymous
// intrinsic is reached here by a second, hand-written route and compared - and
// then check that the membrane actually treats the whole set as primordial.

import { getIntrinsics } from '../../src/intrinsics.js'

export default function run (test, exports, helpers) {
  const { Membrane } = exports

  test('intrinsics - the record is a null-prototype map of live references', (t) => {
    const intrinsics = getIntrinsics()
    t.equal(Object.getPrototypeOf(intrinsics), null, 'no prototype, so no inherited keys')

    const names = Object.keys(intrinsics)
    t.ok(names.length > 100, `collected a full realm (${names.length} names)`)

    let bad = 0
    for (const name of names) {
      const value = intrinsics[name]
      const type = typeof value
      if (value === null || (type !== 'object' && type !== 'function')) {
        bad++
        t.fail(`${name} is not a reference: ${String(value)}`)
      }
    }
    t.equal(bad, 0, 'every collected intrinsic is an object or a function')
    t.end()
  })

  test('intrinsics - named intrinsics have the right identity', (t) => {
    const i = getIntrinsics()
    const expected = {
      Object,
      Array,
      Function,
      JSON,
      Math,
      Reflect,
      Symbol,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Proxy,
      RegExp,
      Date,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      eval,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      decodeURI,
      encodeURI
    }
    for (const [name, value] of Object.entries(expected)) {
      t.equal(i[name], value, `${name} is the realm's own`)
    }
    t.end()
  })

  test('intrinsics - prototypes are resolved off their constructors', (t) => {
    const i = getIntrinsics()
    const expected = {
      ObjectPrototype: Object.prototype,
      ArrayPrototype: Array.prototype,
      FunctionPrototype: Function.prototype,
      StringPrototype: String.prototype,
      NumberPrototype: Number.prototype,
      BooleanPrototype: Boolean.prototype,
      RegExpPrototype: RegExp.prototype,
      DatePrototype: Date.prototype,
      ErrorPrototype: Error.prototype,
      TypeErrorPrototype: TypeError.prototype,
      MapPrototype: Map.prototype,
      SetPrototype: Set.prototype,
      PromisePrototype: Promise.prototype,
      SymbolPrototype: Symbol.prototype,
      WeakMapPrototype: WeakMap.prototype
    }
    for (const [name, value] of Object.entries(expected)) {
      t.equal(i[name], value, `${name} is the realm's own`)
    }
    // these three are the ones a Compartment-derived list cannot reach, which is
    // why the collector exists at all
    t.equal(i.ObjectPrototype, Object.prototype, 'Object.prototype specifically')
    t.equal(i.ArrayPrototype, Array.prototype, 'Array.prototype specifically')
    t.equal(i.FunctionPrototype, Function.prototype, 'Function.prototype specifically')
    t.end()
  })

  // Each of these has no name on the global object. The collector reaches them
  // by construction; here they are reached again by a different construction and
  // the identities compared.
  test('intrinsics - anonymous intrinsics are reached correctly', (t) => {
    const i = getIntrinsics()

    t.equal(i.ArrayIteratorPrototype, Object.getPrototypeOf([][Symbol.iterator]()),
      'ArrayIteratorPrototype')
    t.equal(i.StringIteratorPrototype, Object.getPrototypeOf(''[Symbol.iterator]()),
      'StringIteratorPrototype')
    t.equal(i.MapIteratorPrototype, Object.getPrototypeOf(new Map()[Symbol.iterator]()),
      'MapIteratorPrototype')
    t.equal(i.SetIteratorPrototype, Object.getPrototypeOf(new Set()[Symbol.iterator]()),
      'SetIteratorPrototype')
    t.equal(i.IteratorPrototype, Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
      'IteratorPrototype')
    t.equal(i.TypedArray, Object.getPrototypeOf(Uint8Array), 'TypedArray')
    t.equal(i.TypedArrayPrototype, Object.getPrototypeOf(Uint8Array).prototype,
      'TypedArrayPrototype')
    t.equal(i.FunctionPrototypeConstructor, Function.prototype.constructor,
      'FunctionPrototypeConstructor')

    t.equal(i.GeneratorFunction, Object.getPrototypeOf(function * () {}).constructor,
      'GeneratorFunction')
    t.equal(i.Generator, Object.getPrototypeOf(function * () {}).constructor.prototype,
      'Generator')
    t.equal(i.AsyncFunction, Object.getPrototypeOf(async function () {}).constructor,
      'AsyncFunction')
    t.equal(i.AsyncGeneratorFunction, Object.getPrototypeOf(async function * () {}).constructor,
      'AsyncGeneratorFunction')
    t.equal(i.AsyncIteratorPrototype,
      Object.getPrototypeOf(Object.getPrototypeOf(async function * () {}).constructor.prototype.prototype),
      'AsyncIteratorPrototype')

    // %ThrowTypeError%: the poisoned accessor a strict arguments object exposes
    t.equal(typeof i.ThrowTypeError, 'function', 'ThrowTypeError is a function')
    t.throws(() => i.ThrowTypeError(), TypeError, 'and it throws a TypeError when called')
    t.equal(i.ThrowTypeError, Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get,
      'and is the same poisoned accessor the spec shares')

    // late enough that a realm may legitimately lack it
    if (typeof Symbol.matchAll === 'symbol' && ''.matchAll) {
      t.equal(i.RegExpStringIteratorPrototype,
        Object.getPrototypeOf('a'.matchAll(/a/g)), 'RegExpStringIteratorPrototype')
    } else {
      t.pass('RegExpStringIteratorPrototype skipped: realm has no Symbol.matchAll')
    }
    t.end()
  })

  test('intrinsics - collection is stable across calls', (t) => {
    const first = getIntrinsics()
    const second = getIntrinsics()
    t.notEqual(first, second, 'a fresh record each call')
    t.deepEqual(Object.keys(first).sort(), Object.keys(second).sort(), 'with the same names')

    let differing = 0
    for (const name of Object.keys(first)) {
      if (first[name] !== second[name]) differing++
    }
    t.equal(differing, 0, 'and identical values throughout')
    t.end()
  })

  test('intrinsics - absent realm features are omitted, not left undefined', (t) => {
    const i = getIntrinsics()
    for (const name of Object.keys(i)) {
      t.notEqual(i[name], undefined, `${name} is not undefined`)
    }
    // SES-only names must not appear unless SES is actually loaded
    for (const name of ['Compartment', 'CompartmentPrototype', 'harden']) {
      t.equal(name in i, name in globalThis, `${name} present only if the realm has it`)
    }
    t.end()
  })

  //
  // the reason any of this matters
  //

  test('intrinsics - the membrane passes every collected intrinsic through raw', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const intrinsics = getIntrinsics()

    let wrapped = 0
    for (const name of Object.keys(intrinsics)) {
      const value = intrinsics[name]
      if (membrane.bridge(value, a, b) !== value) {
        wrapped++
        t.fail(`${name} was wrapped by the membrane`)
      }
    }
    t.equal(wrapped, 0, 'no intrinsic is ever wrapped')
    t.end()
  })

  test('intrinsics - identity survives the membrane for builtins', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    const arr = membrane.bridge([1, 2, 3], a, b)
    t.ok(Array.isArray(arr), 'Array.isArray holds across the membrane')
    t.ok(arr instanceof Array, 'instanceof Array holds')

    const err = membrane.bridge(new TypeError('x'), a, b)
    t.ok(err instanceof Error, 'instanceof Error holds')
    t.ok(err instanceof TypeError, 'instanceof TypeError holds')

    const fn = membrane.bridge(function named () {}, a, b)
    t.ok(fn instanceof Function, 'instanceof Function holds')

    // and the shared prototypes are literally the same objects
    t.equal(membrane.bridge(Object.prototype, a, b), Object.prototype, 'Object.prototype shared')
    t.equal(membrane.bridge(Array.prototype, a, b), Array.prototype, 'Array.prototype shared')
    t.end()
  })

  test('intrinsics - the primordials option still overrides completely', (t) => {
    const custom = { tag: 'declared primordial' }
    const membrane = new Membrane({ primordials: [custom] })
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    t.equal(membrane.bridge(custom, a, b), custom, 'the declared value passes through')
    t.notEqual(membrane.bridge(Object.prototype, a, b), Object.prototype,
      'and a real intrinsic absent from the list is wrapped')
    t.end()
  })
}
