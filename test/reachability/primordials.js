// Primordials, primitives, and the decision not to bridge.
//
// Primordials are shared across every space by design - wrapping Object.prototype
// per space would break every instanceof and every builtin. That makes the
// primordial test part of the isolation boundary rather than an optimisation:
// anything wrongly classified as primordial is passed raw between spaces.

export default function run (test, exports, helpers) {
  const { Membrane } = exports

  const plain = () => {
    const membrane = new Membrane()
    return {
      membrane,
      a: membrane.makeMembraneSpace({ label: 'a' }),
      b: membrane.makeMembraneSpace({ label: 'b' })
    }
  }

  test('primordials - well known intrinsics pass through unwrapped', (t) => {
    const { membrane, a, b } = plain()
    const intrinsics = [
      ['Object.prototype', Object.prototype],
      ['Array.prototype', Array.prototype],
      ['Function.prototype', Function.prototype],
      ['Object', Object],
      ['Array', Array],
      ['Function', Function],
      ['JSON', JSON],
      ['Math', Math],
      ['Reflect', Reflect],
      ['Promise', Promise],
      ['Symbol', Symbol],
      ['Error.prototype', Error.prototype],
      ['RegExp.prototype', RegExp.prototype],
      ['Date.prototype', Date.prototype],
      ['Map', Map],
      ['Set', Set],
      ['WeakMap', WeakMap]
    ]
    for (const [label, value] of intrinsics) {
      t.equal(membrane.bridge(value, a, b), value, `${label} passes through identically`)
    }
    t.end()
  })

  test('primordials - pass through in both directions and are never wrapped', (t) => {
    const { membrane, a, b } = plain()
    t.equal(membrane.bridge(Object.prototype, a, b), Object.prototype, 'A to B')
    t.equal(membrane.bridge(Object.prototype, b, a), Object.prototype, 'B to A')
    t.notOk(membrane.isWrapped(Object.prototype), 'never reported as wrapped')
    t.equal(membrane.getOriginSpace(Object.prototype), undefined, 'and never attributed an origin')
    t.end()
  })

  test('primordials - shouldSkipBridge agrees with bridge', (t) => {
    const { membrane, a, b } = plain()
    const cases = [
      ['null', null, true],
      ['undefined', undefined, true],
      ['number', 42, true],
      ['string', 'hello', true],
      ['boolean', true, true],
      ['symbol', Symbol('s'), true],
      ['bigint', 10n, true],
      ['Object.prototype', Object.prototype, true],
      ['plain object', { tag: 'x' }, false],
      ['array', [1, 2], false],
      ['function', () => {}, false]
    ]
    for (const [label, value, expected] of cases) {
      t.equal(membrane.shouldSkipBridge(value), expected, `shouldSkipBridge(${label}) is ${expected}`)
      if (expected) {
        t.equal(membrane.bridge(value, a, b), value, `and bridge(${label}) passes it through`)
      } else {
        t.notEqual(membrane.bridge(value, a, b), value, `and bridge(${label}) wraps it`)
      }
    }
    t.end()
  })

  test('primordials - primitives of every kind pass through', (t) => {
    const { membrane, a, b } = plain()
    const sym = Symbol('unique')
    const cases = [
      ['zero', 0], ['negative zero', -0], ['NaN', NaN], ['Infinity', Infinity],
      ['empty string', ''], ['long string', 'x'.repeat(10000)],
      ['true', true], ['false', false], ['undefined', undefined], ['null', null],
      ['bigint', 123456789012345678901234567890n], ['symbol', sym]
    ]
    for (const [label, value] of cases) {
      const out = membrane.bridge(value, a, b)
      if (Number.isNaN(value)) t.ok(Number.isNaN(out), `${label} passes through`)
      else t.equal(out, value, `${label} passes through`)
    }
    t.equal(1 / membrane.bridge(-0, a, b), -Infinity, 'negative zero keeps its sign')
    t.end()
  })

  test('primordials - a custom list overrides the snapshot completely', (t) => {
    const custom = { tag: 'declared primordial' }
    const membrane = new Membrane({ primordials: [custom] })
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    t.equal(membrane.bridge(custom, a, b), custom, 'a declared primordial passes through raw')
    // a real intrinsic is NOT in the custom list, so it gets wrapped
    const wrapped = membrane.bridge(Object.prototype, a, b)
    t.notEqual(wrapped, Object.prototype, 'a real intrinsic absent from the list is wrapped')
    t.ok(membrane.isWrapped(wrapped), 'and reported wrapped')
    t.end()
  })

  test('primordials - an array in a custom list is passed through', (t) => {
    const arrayPrimordial = [1, 2, 3]
    const membrane = new Membrane({ primordials: [arrayPrimordial] })
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    t.equal(membrane.bridge(arrayPrimordial, a, b), arrayPrimordial,
      'an array declared primordial passes through raw')
    t.equal(membrane.shouldSkipBridge(arrayPrimordial), true, 'and shouldSkipBridge agrees')
    t.end()
  })

  test('primordials - the public list is a copy, not shared state', (t) => {
    const first = new Membrane()
    const originalLength = first.primordials.length
    t.ok(originalLength > 50, 'the snapshot is populated')

    first.primordials.push({ tag: 'injected' })
    const second = new Membrane()
    t.equal(second.primordials.length, originalLength,
      "mutating one Membrane's list does not affect the next")
    t.notOk(second.primordials.some((v) => v && v.tag === 'injected'),
      'the injected value did not propagate')
    t.end()
  })

  test('primordials - the injected value is not treated as primordial by others', (t) => {
    const first = new Membrane()
    const injected = { tag: 'injected' }
    first.primordials.push(injected)

    const second = new Membrane()
    const a = second.makeMembraneSpace({ label: 'a' })
    const b = second.makeMembraneSpace({ label: 'b' })
    t.notEqual(second.bridge(injected, a, b), injected, 'a later Membrane still wraps it')
    t.end()
  })

  test('primordials - two Membranes agree on the snapshot', (t) => {
    const first = new Membrane()
    const second = new Membrane()
    t.equal(first.primordials.length, second.primordials.length, 'same size')
    const firstSet = new Set(first.primordials)
    t.ok(second.primordials.every((v) => firstSet.has(v)), 'same members')
    t.notEqual(first.primordials, second.primordials, 'but not the same array object')
    t.end()
  })

  test('primordials - bridging within one space is a no-op', (t) => {
    const { membrane, a } = plain()
    const obj = { tag: 'a:obj' }
    const arr = [1, 2]
    t.equal(membrane.bridge(obj, a, a), obj, 'an object is returned unchanged')
    t.equal(membrane.bridge(arr, a, a), arr, 'an array is returned unchanged')
    t.equal(membrane.bridge(42, a, a), 42, 'a primitive is returned unchanged')
    t.equal(membrane.bridge(null, a, a), null, 'null is returned unchanged')
    t.equal(membrane.getOriginSpace(obj), undefined, 'and no origin is recorded')
    t.end()
  })

  test('primordials - instanceof works across the membrane for builtins', (t) => {
    const { membrane, a, b } = plain()
    const proxy = membrane.bridge({ x: 1 }, a, b)
    t.ok(proxy instanceof Object, 'a wrapped object is still an Object')

    const arrProxy = membrane.bridge([1, 2, 3], a, b)
    t.ok(Array.isArray(arrProxy), 'Array.isArray pierces the proxy')
    t.ok(arrProxy instanceof Array, 'and instanceof Array holds')

    const fnProxy = membrane.bridge(function named () {}, a, b)
    t.equal(typeof fnProxy, 'function', 'a wrapped function is typeof function')
    t.ok(fnProxy instanceof Function, 'and instanceof Function')
    t.end()
  })

  test('primordials - a primordial reached through a wrapped object stays raw', (t) => {
    const { membrane, a, b } = plain()
    const obj = { theProto: Object.prototype, theMath: Math, theJSON: JSON }
    const proxy = membrane.bridge(obj, a, b)

    t.equal(proxy.theProto, Object.prototype, 'a primordial property is not wrapped')
    t.equal(proxy.theMath, Math, 'Math is not wrapped')
    t.equal(proxy.theJSON, JSON, 'JSON is not wrapped')
    t.end()
  })

  test('primordials - a primordial passed as an argument stays raw', (t) => {
    const { membrane, a, b } = plain()
    let seen
    const proxy = membrane.bridge((x) => { seen = x; return x }, a, b)
    const returned = proxy(Math)
    t.equal(seen, Math, 'the origin side received the raw primordial')
    t.equal(returned, Math, 'and it came back raw')
    t.end()
  })
}
