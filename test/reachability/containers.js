// The proxy protocol's own transport containers.
//
// The key list, the property descriptors and the argument list are containers
// the proxy protocol mints for itself. They used to be bridged whole - each
// becoming a membrane proxy that the engine then read through - and are now
// copied, with only the fields that can carry a reference bridged individually.
//
// Copying is only safe if it is observationally identical, so these tests push
// on the places where a copy could differ from a proxy: keys that are not
// strings or symbols, descriptors with unusual or invalid shapes, non-
// configurable descriptors that must be mirrored onto the fake target, and
// argument lists of every shape.

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { skipPrimordialsOf } = helpers

  const distorted = (traps) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({
      label: 'a',
      createHandler: () => ({ ...reflectHandler(), ...traps })
    })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    return { membrane, a, b }
  }

  const plain = () => {
    const membrane = new Membrane()
    return {
      membrane,
      a: membrane.makeMembraneSpace({ label: 'a' }),
      b: membrane.makeMembraneSpace({ label: 'b' })
    }
  }

  //
  // ownKeys
  //

  test('containers - ownKeys returns strings and symbols in order', (t) => {
    const { membrane, a, b } = plain()
    const sym = Symbol('s')
    const obj = { first: 1, 2: 'two', last: 3, [sym]: 4 }
    const proxy = membrane.bridge(obj, a, b)

    const rawKeys = Reflect.ownKeys(obj)
    const proxyKeys = Reflect.ownKeys(proxy)
    t.deepEqual(proxyKeys.map(String), rawKeys.map(String), 'the same keys in the same order')
    t.ok(proxyKeys.includes(sym), 'the symbol key survives as the same symbol')
    t.deepEqual(Object.keys(proxy), Object.keys(obj), 'Object.keys agrees')
    t.deepEqual(Object.getOwnPropertyNames(proxy), Object.getOwnPropertyNames(obj), 'getOwnPropertyNames agrees')
    t.deepEqual(Object.getOwnPropertySymbols(proxy), Object.getOwnPropertySymbols(obj), 'getOwnPropertySymbols agrees')
    t.end()
  })

  test('containers - ownKeys copy is fresh each call', (t) => {
    const { membrane, a, b } = plain()
    const proxy = membrane.bridge({ x: 1, y: 2 }, a, b)
    const first = Reflect.ownKeys(proxy)
    const second = Reflect.ownKeys(proxy)
    t.notEqual(first, second, 'a new array each time')
    t.deepEqual(first, second, 'with identical contents')
    first.push('injected')
    t.deepEqual(Reflect.ownKeys(proxy), second, 'mutating a returned list does not affect the membrane')
    t.end()
  })

  test('containers - a distortion cannot smuggle an object through ownKeys', (t) => {
    const secret = { tag: 'SECRET' }
    const { membrane, a, b } = distorted({ ownKeys: () => ['ok', secret] })
    const proxy = membrane.bridge({ ok: 1 }, a, b)

    let caught
    try { Reflect.ownKeys(proxy) } catch (err) { caught = err }
    t.ok(caught instanceof TypeError, 'the engine rejects a non-string, non-symbol key')
    t.notOk(String(caught && caught.message).includes('SECRET'), 'and the object is not exposed in the message')
    t.end()
  })

  test('containers - a distortion may filter and reorder keys', (t) => {
    const { membrane, a, b } = distorted({
      ownKeys: (target) => Reflect.ownKeys(target).filter((k) => k !== 'hidden').reverse()
    })
    const proxy = membrane.bridge({ a: 1, hidden: 2, z: 3 }, a, b)
    const keys = Reflect.ownKeys(proxy)

    t.notOk(keys.includes('hidden'), 'the filtered key is gone')
    t.deepEqual(keys, ['z', 'a'], 'and the order the distortion chose is preserved')
    t.end()
  })

  test('containers - duplicate keys from a distortion are rejected', (t) => {
    const { membrane, a, b } = distorted({ ownKeys: () => ['dup', 'dup'] })
    const proxy = membrane.bridge({ dup: 1 }, a, b)
    t.throws(() => Reflect.ownKeys(proxy), TypeError, 'duplicates are a TypeError')
    t.end()
  })

  test('containers - many keys survive the copy', (t) => {
    const { membrane, a, b } = plain()
    const obj = {}
    for (let i = 0; i < 500; i++) obj[`k${i}`] = i
    const proxy = membrane.bridge(obj, a, b)
    const keys = Reflect.ownKeys(proxy)
    t.equal(keys.length, 500, 'all 500 keys came across')
    t.equal(keys[0], 'k0', 'first key correct')
    t.equal(keys[499], 'k499', 'last key correct')
    t.end()
  })

  //
  // descriptors
  //

  test('containers - a data descriptor has the canonical shape', (t) => {
    const { membrane, a, b } = plain()
    const proxy = membrane.bridge({ x: 'value' }, a, b)
    const desc = Object.getOwnPropertyDescriptor(proxy, 'x')

    t.deepEqual(Object.keys(desc).sort(), ['configurable', 'enumerable', 'value', 'writable'],
      'exactly the four data fields')
    t.equal(desc.value, 'value', 'value')
    t.equal(desc.writable, true, 'writable')
    t.equal(desc.enumerable, true, 'enumerable')
    t.equal(desc.configurable, true, 'configurable')
    t.end()
  })

  test('containers - an accessor descriptor has the canonical shape', (t) => {
    const { membrane, a, b } = plain()
    const obj = { get x () { return 1 }, set x (v) {} }
    const proxy = membrane.bridge(obj, a, b)
    const desc = Object.getOwnPropertyDescriptor(proxy, 'x')

    t.deepEqual(Object.keys(desc).sort(), ['configurable', 'enumerable', 'get', 'set'],
      'exactly the four accessor fields')
    t.equal(typeof desc.get, 'function', 'getter present')
    t.equal(typeof desc.set, 'function', 'setter present')
    t.ok(membrane.isWrapped(desc.get), 'the getter is bridged')
    t.ok(membrane.isWrapped(desc.set), 'the setter is bridged')
    t.notOk('value' in desc, 'no value field')
    t.notOk('writable' in desc, 'no writable field')
    t.end()
  })

  test('containers - descriptor values are bridged', (t) => {
    const { membrane, a, b } = plain()
    const inner = { tag: 'a:inner' }
    const proxy = membrane.bridge({ inner }, a, b)
    const desc = Object.getOwnPropertyDescriptor(proxy, 'inner')

    t.notEqual(desc.value, inner, 'not the raw object')
    t.ok(membrane.isWrapped(desc.value), 'bridged instead')
    t.equal(desc.value, proxy.inner, 'and identical to the ordinary read')
    t.end()
  })

  test('containers - extra descriptor fields from a distortion are dropped', (t) => {
    const secret = { tag: 'SECRET' }
    const { membrane, a, b } = distorted({
      getOwnPropertyDescriptor: () => ({
        value: 1, writable: true, enumerable: true, configurable: true, sneaky: secret
      })
    })
    const proxy = membrane.bridge({ ok: 1 }, a, b)
    const desc = Object.getOwnPropertyDescriptor(proxy, 'ok')

    t.deepEqual(Object.keys(desc).sort(), ['configurable', 'enumerable', 'value', 'writable'],
      'only the standard fields survive')
    t.notOk(Object.values(desc).includes(secret), 'the smuggled object is gone')
    t.end()
  })

  test('containers - a malformed descriptor is rejected by the engine', (t) => {
    const { membrane, a, b } = distorted({
      getOwnPropertyDescriptor: () => ({ value: 1, get: () => 2, configurable: true })
    })
    const proxy = membrane.bridge({ ok: 1 }, a, b)
    t.throws(() => Object.getOwnPropertyDescriptor(proxy, 'ok'), TypeError,
      'both value and get is a TypeError')
    t.end()
  })

  test('containers - a missing property yields undefined', (t) => {
    const { membrane, a, b } = plain()
    const proxy = membrane.bridge({ x: 1 }, a, b)
    t.equal(Object.getOwnPropertyDescriptor(proxy, 'nope'), undefined, 'undefined for an absent key')
    t.end()
  })

  test('containers - non-configurable descriptors stay stable across reads', (t) => {
    const { membrane, a, b } = plain()
    const inner = { tag: 'a:inner' }
    const obj = {}
    Object.defineProperty(obj, 'fixed', {
      value: inner, writable: false, enumerable: true, configurable: false
    })
    const proxy = membrane.bridge(obj, a, b)

    const first = Object.getOwnPropertyDescriptor(proxy, 'fixed')
    const second = Object.getOwnPropertyDescriptor(proxy, 'fixed')
    t.equal(first.value, second.value, 'the value is identity-stable')
    t.equal(first.configurable, false, 'non-configurable is reported')
    t.notEqual(first.value, inner, 'and the raw value did not leak')
    t.ok(membrane.isWrapped(first.value), 'it is bridged')
    t.equal(proxy.fixed, first.value, 'an ordinary read agrees')
    t.end()
  })

  test('containers - two spaces keep separate fake targets for one raw ref', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })
    const inner = { tag: 'a:inner' }
    const obj = {}
    Object.defineProperty(obj, 'fixed', {
      value: inner, writable: false, enumerable: true, configurable: false
    })
    const inB = membrane.bridge(obj, a, b)
    const inC = membrane.bridge(obj, a, c)

    const bVal = Object.getOwnPropertyDescriptor(inB, 'fixed').value
    const cVal = Object.getOwnPropertyDescriptor(inC, 'fixed').value
    t.notEqual(bVal, cVal, 'B and C get different bridged values')
    t.notEqual(bVal, inner, 'neither is raw')
    t.notEqual(cVal, inner, 'neither is raw')
    t.ok(membrane.isWrapped(bVal) && membrane.isWrapped(cVal), 'both are wrapped')
    t.end()
  })

  test('containers - defineProperty round trips data and accessor descriptors', (t) => {
    const { membrane, a, b } = plain()
    const target = {}
    const proxy = membrane.bridge(target, a, b)

    Object.defineProperty(proxy, 'data', { value: 42, enumerable: true, configurable: true, writable: true })
    t.equal(target.data, 42, 'a data property landed on the raw object')

    const bObject = { tag: 'b:object' }
    Object.defineProperty(proxy, 'obj', { value: bObject, enumerable: true, configurable: true, writable: true })
    t.notEqual(target.obj, bObject, "B's raw object did not land in A")
    t.ok(membrane.isWrapped(target.obj), 'A holds a bridged view')

    Object.defineProperty(proxy, 'acc', { get: () => 'from-b', enumerable: true, configurable: true })
    t.equal(proxy.acc, 'from-b', 'the accessor reads back correctly')
    t.end()
  })

  //
  // apply / construct argument lists
  //

  test('containers - argument lists of every shape are bridged', (t) => {
    const { membrane, a, b } = plain()
    let received
    const fn = (...args) => { received = args; return args.length }
    const proxy = membrane.bridge(fn, a, b)

    t.equal(proxy(), 0, 'zero arguments')
    t.equal(received.length, 0, 'and none received')

    t.equal(proxy(1, 'two', true, null, undefined), 5, 'primitives pass through')
    t.deepEqual(received, [1, 'two', true, null, undefined], 'unchanged')

    const o1 = { tag: 'b:o1' }
    const o2 = { tag: 'b:o2' }
    proxy(o1, o2)
    t.notEqual(received[0], o1, 'objects are not passed raw')
    t.ok(membrane.isWrapped(received[0]), 'they are bridged')
    t.equal(received[0].tag, 'b:o1', 'and readable')

    const many = new Array(200).fill(0).map((_, i) => i)
    t.equal(proxy(...many), 200, 'a long argument list works')
    t.end()
  })

  test('containers - a nested array argument is bridged as one reference', (t) => {
    const { membrane, a, b } = plain()
    let received
    const proxy = membrane.bridge((x) => { received = x; return 'ok' }, a, b)

    const nested = [[1, 2], [3, 4]]
    proxy(nested)
    t.notEqual(received, nested, 'the array itself is bridged')
    t.ok(membrane.isWrapped(received), 'and reported wrapped')
    t.equal(received.length, 2, 'length reads through')
    t.equal(received[0][1], 2, 'nested elements read through')
    t.end()
  })

  test('containers - Reflect.apply with an array-like works', (t) => {
    const { membrane, a, b } = plain()
    const proxy = membrane.bridge(function () { return arguments.length }, a, b)
    t.equal(Reflect.apply(proxy, undefined, { length: 3, 0: 'a', 1: 'b', 2: 'c' }), 3,
      'an array-like argument list is accepted')
    t.equal(proxy.apply(undefined, ['x', 'y']), 2, 'Function.prototype.apply works')
    t.equal(proxy.call(undefined, 'x'), 1, 'Function.prototype.call works')
    t.end()
  })

  test('containers - thisArg is bridged on apply', (t) => {
    const { membrane, a, b } = plain()
    let seenThis
    const proxy = membrane.bridge(function () { seenThis = this; return 'ok' }, a, b)
    const bThis = { tag: 'b:this' }

    proxy.call(bThis)
    t.notEqual(seenThis, bThis, "B's raw thisArg did not cross")
    t.ok(membrane.isWrapped(seenThis), 'it was bridged')
    t.equal(seenThis.tag, 'b:this', 'and is readable')
    t.end()
  })

  test('containers - construct arguments are bridged', (t) => {
    const { membrane, a, b } = plain()
    let seen
    function Ctor (arg) { seen = arg; this.ok = true }
    const proxy = membrane.bridge(Ctor, a, b)
    const bArg = { tag: 'b:arg' }

    const instance = new proxy(bArg)
    t.ok(instance.ok, 'construction succeeded')
    t.notEqual(seen, bArg, "B's raw argument did not cross")
    t.ok(membrane.isWrapped(seen), 'it was bridged')
    t.end()
  })

  //
  // preventExtensions and the fake target
  //

  test('containers - preventExtensions transfers state without leaking', (t) => {
    const { membrane, a, b } = plain()
    const inner = { tag: 'a:inner' }
    const obj = { x: 1, inner }
    const proxy = membrane.bridge(obj, a, b)
    const skip = skipPrimordialsOf(membrane)

    t.ok(Reflect.isExtensible(proxy), 'extensible to begin with')
    Object.preventExtensions(proxy)
    t.notOk(Reflect.isExtensible(proxy), 'no longer extensible through the proxy')
    t.notOk(Object.isExtensible(obj), 'and the raw object was actually frozen shut')

    t.deepEqual(Object.getOwnPropertyNames(proxy).sort(), ['inner', 'x'], 'keys still readable')
    t.notEqual(proxy.inner, inner, 'the transferred value is still bridged')
    helpers.assertNoLeak(t, proxy, new Set([obj, inner]), 'preventExtensions leaked nothing raw', { skip })
    t.end()
  })

  // Wrapping an object that was ALREADY non-extensible does not work: the trap
  // reports the raw object's extensibility while the fake target is still
  // extensible, and the engine rejects the mismatch. This is a pre-existing
  // limitation - it behaves identically before and after the refactor, and is
  // recorded here so the suite documents the real boundary rather than an
  // aspiration. Calling preventExtensions *through* the proxy is the supported
  // route, and is covered by the test above.
  test('containers - an already non-extensible object cannot be wrapped (pre-existing)', (t) => {
    const { membrane, a, b } = plain()
    for (const [what, obj] of [
      ['frozen', Object.freeze({ x: 1 })],
      ['sealed', Object.seal({ x: 1 })],
      ['preventExtensions', Object.preventExtensions({ x: 1 })]
    ]) {
      const proxy = membrane.bridge(obj, a, b)
      t.throws(() => Object.isExtensible(proxy), TypeError,
        `isExtensible on a wrapped ${what} object throws the proxy invariant TypeError`)
      t.equal(proxy.x, 1, `but a ${what} object is still readable through the membrane`)
    }
    t.end()
  })

  test('containers - descriptors of a normal object report their flags faithfully', (t) => {
    const { membrane, a, b } = plain()
    const obj = {}
    Object.defineProperty(obj, 'ro', { value: 1, writable: false, enumerable: true, configurable: true })
    const proxy = membrane.bridge(obj, a, b)
    const desc = Object.getOwnPropertyDescriptor(proxy, 'ro')

    t.equal(desc.value, 1, 'value')
    t.equal(desc.writable, false, 'non-writable reported')
    t.equal(desc.enumerable, true, 'enumerable reported')
    t.equal(desc.configurable, true, 'configurable reported')
    t.end()
  })

  //
  // the alwaysUnwrap raw-arguments-array path
  //

  test('containers - alwaysUnwrap copies an array rather than mutating it', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })
    const element = { tag: 'a:element' }
    const arr = [element]

    const out = membrane.bridge(arr, a, u)
    t.notEqual(out, arr, 'a fresh array, not the caller\'s')
    t.equal(arr.length, 1, 'the original is untouched')
    t.equal(arr[0], element, 'and still holds its element')
    t.equal(out.length, 1, 'the copy has the same length')
    t.end()
  })

  // The old implementation used rawRef.map(), which skips holes; the new one uses
  // an index loop, which materialises them as undefined. Recorded as current
  // behaviour - no reference can travel through a hole either way.
  test('containers - alwaysUnwrap materialises holes in a sparse array', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })
    const sparse = [1, , 3] // eslint-disable-line no-sparse-arrays

    const out = membrane.bridge(sparse, a, u)
    t.equal(out.length, 3, 'length preserved')
    t.equal(out[0], 1, 'first element preserved')
    t.equal(out[2], 3, 'last element preserved')
    t.equal(out[1], undefined, 'the hole reads as undefined')
    t.ok(1 in out, 'and is materialised as a real property')
    t.end()
  })

  test('containers - alwaysUnwrap does not invoke user array methods', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })

    let mapCalled = 0
    const arr = [1, 2, 3]
    arr.map = function () { mapCalled++; return [] }

    const out = membrane.bridge(arr, a, u)
    t.equal(mapCalled, 0, 'a poisoned map on the array was never called')
    t.equal(out.length, 3, 'the copy is complete')
    t.deepEqual([out[0], out[1], out[2]], [1, 2, 3], 'with the right contents')
    t.end()
  })
}

function reflectHandler () {
  const handler = {}
  for (const key of Reflect.ownKeys(Reflect)) handler[key] = Reflect[key]
  return handler
}
