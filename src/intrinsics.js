// The realm's intrinsics, collected so the membrane knows what never to wrap.
//
// Primordials are shared by every space by design: wrapping Object.prototype
// per space would break instanceof and every builtin. So this list is part of
// the isolation boundary rather than an optimisation - anything missing from it
// gets wrapped, and a wrapped primordial changes identity across the membrane.
//
// This replaces a vendored, Babel-compiled fork of SES's intrinsics machinery
// that lived under lib/ as nine CommonJS files. The npm `ses` package cannot
// stand in for it: its only public surface is a shim that installs lockdown,
// Compartment and assert as globals, and the intrinsics collector it uses
// internally is not reachable through its exports map. Deriving the list from a
// Compartment's globalThis reaches 46 of the 106 values and misses
// Object.prototype, Array.prototype and Function.prototype, because those are
// prototypes rather than global properties.
//
// The approach is the same one the specification describes for CreateIntrinsics,
// with the simplifications SES made: intrinsics unreachable from JavaScript are
// omitted, and the global property name is used instead of the '%Name%' form.

const { getOwnPropertyDescriptor, getPrototypeOf } = Object
const hasOwn = Object.prototype.hasOwnProperty

const PROTOTYPE_SUFFIX = 'Prototype'

// Table 8 of "Well-Known Intrinsic Objects", plus the Annex B additions, with
// the leading and trailing '%' removed. Kept as the spec's own list so changes
// to the spec are easy to track.
//
// Deliberately absent, because the spec documents them as unreachable from
// JavaScript: %ForInIteratorPrototype% and %AsyncFromSyncIteratorPrototype%.
const intrinsicNames = [
  'Array', 'ArrayBuffer', 'ArrayBufferPrototype', 'ArrayIteratorPrototype',
  'ArrayPrototype', 'AsyncFunction', 'AsyncFunctionPrototype', 'AsyncGenerator',
  'AsyncGeneratorFunction', 'AsyncGeneratorPrototype', 'AsyncIteratorPrototype',
  'Atomics', 'BigInt', 'BigIntPrototype', 'BigInt64Array',
  'BigInt64ArrayPrototype', 'BigUint64Array', 'BigUint64ArrayPrototype',
  'Boolean', 'BooleanPrototype', 'DataView', 'DataViewPrototype', 'Date',
  'DatePrototype', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'Error', 'ErrorPrototype', 'eval', 'EvalError',
  'EvalErrorPrototype', 'Float32Array', 'Float32ArrayPrototype', 'Float64Array',
  'Float64ArrayPrototype', 'Function', 'FunctionPrototype', 'Generator',
  'GeneratorFunction', 'GeneratorPrototype', 'Int8Array', 'Int8ArrayPrototype',
  'Int16Array', 'Int16ArrayPrototype', 'Int32Array', 'Int32ArrayPrototype',
  'isFinite', 'isNaN', 'IteratorPrototype', 'JSON', 'Map',
  'MapIteratorPrototype', 'MapPrototype', 'Math', 'Number', 'NumberPrototype',
  'Object', 'ObjectPrototype', 'parseFloat', 'parseInt', 'Promise',
  'PromisePrototype', 'Proxy', 'RangeError', 'RangeErrorPrototype',
  'ReferenceError', 'ReferenceErrorPrototype', 'Reflect', 'RegExp',
  'RegExpPrototype', 'RegExpStringIteratorPrototype', 'Set',
  'SetIteratorPrototype', 'SetPrototype', 'SharedArrayBuffer',
  'SharedArrayBufferPrototype', 'String', 'StringIteratorPrototype',
  'StringPrototype', 'Symbol', 'SymbolPrototype', 'SyntaxError',
  'SyntaxErrorPrototype', 'ThrowTypeError', 'TypedArray',
  'TypedArrayPrototype', 'TypeError', 'TypeErrorPrototype', 'Uint8Array',
  'Uint8ArrayPrototype', 'Uint8ClampedArray', 'Uint8ClampedArrayPrototype',
  'Uint16Array', 'Uint16ArrayPrototype', 'Uint32Array', 'Uint32ArrayPrototype',
  'URIError', 'URIErrorPrototype', 'WeakMap', 'WeakMapPrototype', 'WeakSet',
  'WeakSetPrototype',
  // B.2.1, Table 87: Additional Well-known Intrinsic Objects
  'escape', 'unescape',
  // not in the spec's table, but reachable and worth pinning
  'FunctionPrototypeConstructor',
  // present only once SES has been loaded; absent otherwise, which is fine
  'Compartment', 'CompartmentPrototype', 'harden'
]

const getConstructorOf = (obj) => getPrototypeOf(obj).constructor

// The intrinsics with no name of their own on the global object. Each one is
// reached by constructing a value and walking to its prototype - the only route
// the language offers.
function getAnonymousIntrinsics () {
  // %ThrowTypeError%. This file is a module and therefore strict, so an
  // arguments object exposes `callee` as the poisoned accessor pair rather than
  // as a data property.
  // eslint-disable-next-line prefer-rest-params
  const ThrowTypeError = (function () {
    return getOwnPropertyDescriptor(arguments, 'callee').get
  })()

  const StringIteratorPrototype = getPrototypeOf(new String()[Symbol.iterator]()) // eslint-disable-line no-new-wrappers
  const ArrayIteratorPrototype = getPrototypeOf(new Array()[Symbol.iterator]()) // eslint-disable-line no-array-constructor
  const MapIteratorPrototype = getPrototypeOf(new Map()[Symbol.iterator]())
  const SetIteratorPrototype = getPrototypeOf(new Set()[Symbol.iterator]())
  const IteratorPrototype = getPrototypeOf(ArrayIteratorPrototype)
  const TypedArray = getPrototypeOf(Float32Array)

  // Symbol.matchAll is late enough that a realm may not have it
  let RegExpStringIteratorPrototype
  try {
    RegExpStringIteratorPrototype = getPrototypeOf(new RegExp()[Symbol.matchAll]())
  } catch (err) {
    RegExpStringIteratorPrototype = undefined
  }

  function * GeneratorFunctionInstance () {}
  const GeneratorFunction = getConstructorOf(GeneratorFunctionInstance)
  const Generator = GeneratorFunction.prototype

  async function * AsyncGeneratorFunctionInstance () {}
  const AsyncGeneratorFunction = getConstructorOf(AsyncGeneratorFunctionInstance)
  const AsyncGenerator = AsyncGeneratorFunction.prototype
  const AsyncGeneratorPrototype = AsyncGenerator.prototype
  const AsyncIteratorPrototype = getPrototypeOf(AsyncGeneratorPrototype)

  async function AsyncFunctionInstance () {}
  const AsyncFunction = getConstructorOf(AsyncFunctionInstance)

  return {
    ArrayIteratorPrototype,
    AsyncFunction,
    AsyncGenerator,
    AsyncGeneratorFunction,
    AsyncGeneratorPrototype,
    AsyncIteratorPrototype,
    FunctionPrototypeConstructor: Function.prototype.constructor,
    Generator,
    GeneratorFunction,
    IteratorPrototype,
    MapIteratorPrototype,
    RegExpStringIteratorPrototype,
    SetIteratorPrototype,
    StringIteratorPrototype,
    ThrowTypeError,
    TypedArray
  }
}

// A global property must be a data property. An accessor there would mean the
// realm has been tampered with in a way this collector cannot reason about, and
// silently reading through it could hand back an attacker-chosen value.
function getNamedIntrinsic (root, name) {
  const desc = getOwnPropertyDescriptor(root, name)
  if ('get' in desc || 'set' in desc) {
    throw new TypeError(`unexpected accessor on global property: ${name}`)
  }
  return desc.value
}

/**
 * Returns a record of intrinsic name to value, similar to the [[Intrinsics]]
 * slot of a realm record, with the simplifications described at the top of this
 * file. Names the realm does not have are simply absent.
 */
export function getIntrinsics () {
  const intrinsics = { __proto__: null }
  const anonIntrinsics = getAnonymousIntrinsics()

  for (const name of intrinsicNames) {
    if (hasOwn.call(anonIntrinsics, name)) {
      // an anonymous intrinsic the realm turned out not to have, such as
      // RegExpStringIteratorPrototype without Symbol.matchAll
      if (anonIntrinsics[name] === undefined) continue
      intrinsics[name] = anonIntrinsics[name]
      continue
    }

    if (hasOwn.call(globalThis, name)) {
      intrinsics[name] = getNamedIntrinsic(globalThis, name)
      continue
    }

    // `FooPrototype` is reached as the `prototype` of `Foo`
    if (name.endsWith(PROTOTYPE_SUFFIX)) {
      const prefix = name.slice(0, -PROTOTYPE_SUFFIX.length)
      if (hasOwn.call(anonIntrinsics, prefix) && anonIntrinsics[prefix] !== undefined) {
        intrinsics[name] = anonIntrinsics[prefix].prototype
        continue
      }
      if (hasOwn.call(globalThis, prefix)) {
        intrinsics[name] = getNamedIntrinsic(globalThis, prefix).prototype
      }
    }
  }

  return intrinsics
}
