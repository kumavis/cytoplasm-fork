// Distortions and error bridging.
//
// A distortion decides what a space is allowed to do with a reference, so the
// isolation guarantee depends on it being applied to the right references, with
// the right identity, and on errors it raises not carrying origin-space objects
// out with them.

import createReadOnlyDistortion from '../../src/distortions/readOnly.js'
import createAlwaysThrowDistortion from '../../src/distortions/alwaysThrow.js'

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { skipPrimordialsOf } = helpers

  const withDistortion = (createHandler) => {
    const membrane = new Membrane()
    return {
      membrane,
      a: membrane.makeMembraneSpace({ label: 'a', createHandler }),
      b: membrane.makeMembraneSpace({ label: 'b' })
    }
  }

  //
  // shareable handlers
  //

  test('distortions - a shareable factory builds one handler for the whole space', (t) => {
    let calls = 0
    const factory = (opts) => { calls++; return createReadOnlyDistortion(opts) }
    factory.shareable = true
    const { membrane, a, b } = withDistortion(factory)

    membrane.bridge({ tag: 'one' }, a, b)
    membrane.bridge({ tag: 'two' }, a, b)
    membrane.bridge({ tag: 'three' }, a, b)
    t.equal(calls, 1, 'the factory ran once for three references')
    t.end()
  })

  test('distortions - a non-shareable factory builds one handler per reference', (t) => {
    let calls = 0
    const factory = () => { calls++; return reflectHandler() }
    const { membrane, a, b } = withDistortion(factory)

    membrane.bridge({ tag: 'one' }, a, b)
    membrane.bridge({ tag: 'two' }, a, b)
    membrane.bridge({ tag: 'three' }, a, b)
    t.equal(calls, 3, 'the factory ran once per reference')
    t.end()
  })

  test('distortions - the bundled readOnly and alwaysThrow declare themselves shareable', (t) => {
    t.equal(createReadOnlyDistortion.shareable, true, 'readOnly is shareable')
    t.equal(createAlwaysThrowDistortion.shareable, true, 'alwaysThrow is shareable')
    t.end()
  })

  test('distortions - sharing a handler does not let one reference affect another', (t) => {
    const { membrane, a, b } = withDistortion(createReadOnlyDistortion)
    const first = { value: 'first' }
    const second = { value: 'second' }
    const p1 = membrane.bridge(first, a, b)
    const p2 = membrane.bridge(second, a, b)

    try { p1.value = 'changed' } catch (err) { /* strict mode may throw */ }
    t.equal(first.value, 'first', 'the first object is unchanged')
    t.equal(second.value, 'second', 'and so is the second')
    t.notEqual(p1, p2, 'they remain distinct proxies')
    t.equal(p1.value, 'first', 'and read back independently')
    t.equal(p2.value, 'second', 'and read back independently')
    t.end()
  })

  //
  // readOnly end to end
  //

  test('distortions - readOnly refuses every mutation route', (t) => {
    const { membrane, a, b } = withDistortion(createReadOnlyDistortion)
    const target = { value: 'original', nested: { value: 'nested' } }
    const proxy = membrane.bridge(target, a, b)

    const attempts = [
      ['assignment', () => { proxy.value = 'x' }],
      ['nested assignment', () => { proxy.nested.value = 'x' }],
      ['defineProperty', () => Object.defineProperty(proxy, 'added', { value: 1, configurable: true })],
      ['delete', () => { delete proxy.value }],
      ['setPrototypeOf', () => Object.setPrototypeOf(proxy, null)],
      ['preventExtensions', () => Object.preventExtensions(proxy)]
    ]
    for (const [label, attempt] of attempts) {
      try { attempt() } catch (err) { /* several of these throw in strict mode */ }
      t.equal(target.value, 'original', `${label} did not change the value`)
    }
    t.equal(target.nested.value, 'nested', 'the nested object is untouched')
    t.ok('value' in target, 'the property was not deleted')
    t.notOk('added' in target, 'no property was added')
    t.ok(Object.isExtensible(target), 'the raw object is still extensible')
    t.end()
  })

  test('distortions - readOnly still allows reads', (t) => {
    const { membrane, a, b } = withDistortion(createReadOnlyDistortion)
    const target = { value: 'original', fn: () => 'called', nested: { deep: 1 } }
    const proxy = membrane.bridge(target, a, b)

    t.equal(proxy.value, 'original', 'reads work')
    t.equal(proxy.fn(), 'called', 'calls work')
    t.equal(proxy.nested.deep, 1, 'nested reads work')
    t.ok('value' in proxy, 'has works')
    t.deepEqual(Object.keys(proxy).sort(), ['fn', 'nested', 'value'], 'ownKeys works')
    t.end()
  })

  test('distortions - readOnly makes constructed children mutable via setHandlerForRef', (t) => {
    const { membrane, a, b } = withDistortion(createReadOnlyDistortion)
    function Ctor () { this.value = 'initial' }
    const Wrapped = membrane.bridge(Ctor, a, b)

    const instance = new Wrapped()
    t.equal(instance.value, 'initial', 'the instance is readable')
    instance.value = 'changed'
    t.equal(instance.value, 'changed', 'and writable, because construct re-registered its handler')
    t.end()
  })

  //
  // alwaysThrow
  //

  // The error alwaysThrow raises is itself bridged out of a space whose every
  // trap throws, so the error that arrives cannot even be read - touching
  // `.message` throws again. Assert only that each operation threw.
  const didThrow = (fn) => {
    try { fn(); return false } catch (err) { return true }
  }

  test('distortions - alwaysThrow blocks every trap', (t) => {
    const { membrane, a, b } = withDistortion(createAlwaysThrowDistortion)
    const proxy = membrane.bridge({ value: 1 }, a, b)

    t.ok(didThrow(() => proxy.value), 'get throws')
    t.ok(didThrow(() => { proxy.value = 2 }), 'set throws')
    t.ok(didThrow(() => 'value' in proxy), 'has throws')
    t.ok(didThrow(() => Object.keys(proxy)), 'ownKeys throws')
    t.ok(didThrow(() => Object.getPrototypeOf(proxy)), 'getPrototypeOf throws')
    t.ok(didThrow(() => delete proxy.value), 'deleteProperty throws')
    t.ok(didThrow(() => Object.getOwnPropertyDescriptor(proxy, 'value')), 'getOwnPropertyDescriptor throws')
    t.end()
  })

  test('distortions - an alwaysThrow error is itself unreadable from the out space', (t) => {
    const { membrane, a, b } = withDistortion(createAlwaysThrowDistortion)
    const proxy = membrane.bridge({ value: 1 }, a, b)

    let caught; let threw = false
    try { proxy.value } catch (err) { threw = true; caught = err }
    t.ok(threw, 'reading threw')
    t.ok(didThrow(() => caught.message), 'and even the error message cannot be read back')
    t.end()
  })

  test('distortions - an alwaysThrow error does not carry origin references', (t) => {
    const { membrane, a, b } = withDistortion(createAlwaysThrowDistortion)
    const secret = { tag: 'a:secret' }
    const proxy = membrane.bridge({ secret }, a, b)
    const skip = skipPrimordialsOf(membrane)

    let caught
    try { proxy.secret } catch (err) { caught = err }
    t.ok(caught !== undefined, 'it threw')
    helpers.assertNoLeak(t, caught, new Set([secret]), 'the error reaches no raw origin reference', { skip })
    t.end()
  })

  //
  // error bridging
  //

  test('distortions - a thrown error crosses wrapped, with its message intact', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const raw = new Error('the message')
    raw.payload = { tag: 'a:payload' }
    const proxy = membrane.bridge(() => { throw raw }, a, b)

    let caught
    try { proxy() } catch (err) { caught = err }
    t.notEqual(caught, raw, 'the raw error did not cross')
    t.ok(membrane.isWrapped(caught), 'a bridged error crossed')
    t.equal(caught.message, 'the message', 'the message survives')
    t.equal(typeof caught.stack, 'string', 'the stack survives')
    t.notEqual(caught.payload, raw.payload, 'an attached object is not raw')
    t.ok(membrane.isWrapped(caught.payload), 'it is bridged too')
    t.end()
  })

  test('distortions - non-Error throws cross correctly', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    const cases = [
      ['string', 'just a string'],
      ['number', 42],
      ['null', null],
      ['false', false],
      ['zero', 0]
    ]
    for (const [label, value] of cases) {
      const proxy = membrane.bridge(() => { throw value }, a, b)
      let caught; let didThrow = false
      try { proxy() } catch (err) { didThrow = true; caught = err }
      t.ok(didThrow, `throwing ${label} still throws`)
      t.equal(caught, value, `and ${label} arrives unchanged (it is a primitive)`)
    }
    t.end()
  })

  // The old implementation detected a throw with `if (originErr !== undefined)`,
  // so `throw undefined` was indistinguishable from returning normally and was
  // silently swallowed. The new implementation uses try/catch properly.
  test('distortions - throw undefined actually throws', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const proxy = membrane.bridge(() => { throw undefined }, a, b) // eslint-disable-line no-throw-literal

    let didThrow = false
    let caught = 'not set'
    try { proxy() } catch (err) { didThrow = true; caught = err }
    t.ok(didThrow, 'throwing undefined is not swallowed')
    t.equal(caught, undefined, 'and the thrown value is preserved as undefined')
    t.end()
  })

  test('distortions - an object thrown across is bridged', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const thrown = { tag: 'a:thrown', code: 'E_TEST' }
    const proxy = membrane.bridge(() => { throw thrown }, a, b)

    let caught
    try { proxy() } catch (err) { caught = err }
    t.notEqual(caught, thrown, 'the raw object did not cross')
    t.ok(membrane.isWrapped(caught), 'it is bridged')
    t.equal(caught.code, 'E_TEST', 'and readable')
    t.end()
  })

  test('distortions - debugMode rethrows the raw error', (t) => {
    const membrane = new Membrane({ debugMode: true })
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const raw = new Error('debug me')
    const proxy = membrane.bridge(() => { throw raw }, a, b)

    let caught
    try { proxy() } catch (err) { caught = err }
    t.equal(caught, raw, 'debugMode deliberately lets the raw error through')
    t.end()
  })

  //
  // trap identity
  //

  test('distortions - traps are invoked as methods of the distortion object', (t) => {
    const membrane = new Membrane()
    const seenThis = {}
    let distortion
    const factory = () => {
      distortion = {
        ...reflectHandler(),
        get (target, key, receiver) { seenThis.get = this; return Reflect.get(target, key, receiver) },
        has (target, key) { seenThis.has = this; return Reflect.has(target, key) },
        ownKeys (target) { seenThis.ownKeys = this; return Reflect.ownKeys(target) },
        getPrototypeOf (target) { seenThis.getPrototypeOf = this; return Reflect.getPrototypeOf(target) }
      }
      return distortion
    }
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: factory })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const proxy = membrane.bridge({ x: 1 }, a, b)

    proxy.x
    'x' in proxy // eslint-disable-line no-unused-expressions
    Object.keys(proxy)
    Object.getPrototypeOf(proxy)

    t.equal(seenThis.get, distortion, 'get ran with the distortion as this')
    t.equal(seenThis.has, distortion, 'has ran with the distortion as this')
    t.equal(seenThis.ownKeys, distortion, 'ownKeys ran with the distortion as this')
    t.equal(seenThis.getPrototypeOf, distortion, 'getPrototypeOf ran with the distortion as this')
    t.end()
  })

  test('distortions - setHandlerForRef seeds a handler for a specific reference', (t) => {
    const membrane = new Membrane()
    let capturedSetter
    const factory = ({ setHandlerForRef }) => { capturedSetter = setHandlerForRef; return reflectHandler() }
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: factory })
    const b = membrane.makeMembraneSpace({ label: 'b' })

    const first = { value: 'first' }
    membrane.bridge(first, a, b)
    t.equal(typeof capturedSetter, 'function', 'the factory received setHandlerForRef')

    // seed a throwing handler for a not-yet-wrapped reference
    const special = { value: 'special' }
    capturedSetter(special, createAlwaysThrowDistortion())
    const proxy = membrane.bridge(special, a, b)
    t.throws(() => proxy.value, /exploded as planned/, 'the seeded handler was used')
    t.end()
  })

  test('distortions - a distortion sees the raw reference, never the proxy', (t) => {
    const membrane = new Membrane()
    const targets = []
    const factory = () => ({
      ...reflectHandler(),
      get (target, key, receiver) { targets.push(target); return Reflect.get(target, key, receiver) }
    })
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: factory })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const raw = { x: 1 }
    const proxy = membrane.bridge(raw, a, b)

    proxy.x
    t.equal(targets.length, 1, 'the trap ran once')
    t.equal(targets[0], raw, 'and was handed the raw reference')
    t.notEqual(targets[0], proxy, 'not the proxy')
    t.end()
  })

  test('distortions - a distortion in one space does not affect another space', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const bOwned = { value: 'b-original' }
    const inA = membrane.bridge(bOwned, b, a)
    const inC = membrane.bridge(bOwned, b, c)

    // B's object is not behind A's read-only distortion
    inC.value = 'changed by c'
    t.equal(bOwned.value, 'changed by c', "C could write B's object, since B has no distortion")
    t.equal(inA.value, 'changed by c', 'and A observes the change')
    t.end()
  })
}

function reflectHandler () {
  const handler = {}
  for (const key of Reflect.ownKeys(Reflect)) handler[key] = Reflect[key]
  return handler
}
