// Origin attribution.
//
// A reference's origin space decides two things: which distortion handler wraps
// it for everyone else, and which space gets it back unwrapped. Getting that
// wrong is not a leak in the raw-reference sense - the other space still holds a
// proxy - but it is an authority failure, because the proxy is built with the
// wrong space's handler.
//
// Origin is recorded on first sight and never revised. It used to be re-recorded
// on every bridge of a raw reference, which let a space that legitimately held a
// raw reference launder it: hand it onward, and it was re-attributed to the
// laundering space and re-wrapped with that space's (absent) distortion.

import createReadOnlyDistortion from '../../src/distortions/readOnly.js'

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { skipPrimordialsOf } = helpers

  test('origin - recorded on first sight', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const obj = { tag: 'a:obj' }

    t.equal(membrane.getOriginSpace(obj), undefined, 'unknown before any bridge')
    membrane.bridge(obj, a, b)
    t.equal(membrane.getOriginSpace(obj), a, 'recorded as A after bridging out of A')
    t.end()
  })

  test('origin - survives a laundering attempt through an alwaysUnwrap space', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const secret = { value: 'original' }
    const inU = membrane.bridge(secret, a, u)
    t.equal(inU, secret, 'U legitimately receives the raw reference (opt-in)')

    // U now hands the raw reference onward to a third space
    const inC = membrane.bridge(inU, u, c)

    t.equal(membrane.getOriginSpace(secret), a, 'origin is still A, not U')
    t.notEqual(inC, secret, 'C receives a proxy, not the raw reference')

    // the decisive assertion: C must inherit A's read-only distortion
    let threw = false
    try { inC.value = 'pwned' } catch (err) { threw = true }
    t.equal(secret.value, 'original', "A's object was not mutated through C")
    t.ok(threw || secret.value === 'original', 'the write did not take effect')
    t.end()
  })

  test('origin - survives laundering through a passthroughFilter space', (t) => {
    const membrane = new Membrane()
    const secret = { value: 'original' }
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
    const p = membrane.makeMembraneSpace({ label: 'p', passthroughFilter: (ref) => ref === secret })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const inP = membrane.bridge(secret, a, p)
    t.equal(inP, secret, 'P receives the raw reference via its filter')

    const inC = membrane.bridge(inP, p, c)
    t.equal(membrane.getOriginSpace(secret), a, 'origin is still A, not P')
    try { inC.value = 'pwned' } catch (err) { /* readOnly may throw in strict mode */ }
    t.equal(secret.value, 'original', "A's object was not mutated through C")
    t.end()
  })

  test('origin - a laundered ref still goes home to its true owner', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })

    const obj = { tag: 'a:obj' }
    const inU = membrane.bridge(obj, a, u)
    const backHome = membrane.bridge(inU, u, a)

    t.equal(backHome, obj, 'A receives its own object raw, never a proxy of it')
    t.notOk(membrane.isWrapped(backHome), 'and it is not reported as wrapped')
    t.end()
  })

  test('origin - the wrapping handler follows the origin space, not the sender', (t) => {
    const membrane = new Membrane()
    let aFactoryCalls = 0
    let bFactoryCalls = 0
    // A is read-only; B is deliberately permissive. If the handler followed the
    // sender, C would inherit B's permissiveness.
    const a = membrane.makeMembraneSpace({
      label: 'a',
      createHandler: (opts) => { aFactoryCalls++; return createReadOnlyDistortion(opts) }
    })
    const b = membrane.makeMembraneSpace({
      label: 'b',
      createHandler: () => { bFactoryCalls++; return reflectHandler() }
    })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const target = { value: 'original' }
    const inB = membrane.bridge(target, a, b)
    const inC = membrane.bridge(inB, b, c)

    t.ok(aFactoryCalls >= 1, "A's handler factory was used")
    t.equal(bFactoryCalls, 0, "B's handler factory was never used for A's object")
    try { inC.value = 'pwned' } catch (err) { /* strict mode may throw */ }
    t.equal(target.value, 'original', "C inherited A's read-only distortion, not B's")
    t.end()
  })

  test('origin - a non-shareable handler is built once per reference', (t) => {
    const membrane = new Membrane()
    let calls = 0
    const handlers = new Set()
    const factory = () => { calls++; const h = reflectHandler(); handlers.add(h); return h }
    // no `shareable` flag, so this is the per-reference path
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: factory })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const obj = { tag: 'a:obj' }
    membrane.bridge(obj, a, b)
    t.equal(calls, 1, 'one handler built for the first wrap')
    membrane.bridge(obj, a, c)
    t.equal(calls, 1, 'the same handler is reused when wrapping for a second space')
    t.equal(handlers.size, 1, 'only one handler object exists for this reference')

    const other = { tag: 'a:other' }
    membrane.bridge(other, a, b)
    t.equal(calls, 2, 'a different reference gets its own handler')
    t.end()
  })

  test('origin - is not revised by later bridges', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const obj = { tag: 'a:obj' }
    membrane.bridge(obj, a, b)
    t.equal(membrane.getOriginSpace(obj), a, 'origin A')
    membrane.bridge(obj, a, c)
    t.equal(membrane.getOriginSpace(obj), a, 'still A after a second bridge')
    const inB = membrane.bridge(obj, a, b)
    membrane.bridge(inB, b, c)
    t.equal(membrane.getOriginSpace(obj), a, 'still A after routing the proxy onward')
    t.end()
  })

  // This documents the deliberate trade-off of first-touch attribution. bridge()
  // is a trusted host API - guest code never calls it, because traps always pass
  // the true (originGraph, outGraph) pair - so a caller naming the wrong inGraph
  // is a host bug. Under the old last-writer-wins rule the mistake silently
  // corrected itself; under write-once it is permanent, which is the same
  // property that makes laundering impossible.
  test('origin - first touch wins, so a wrong inGraph is permanent', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const obj = { tag: 'a:obj' }

    // a caller wrongly claims the object came from B
    membrane.bridge(obj, b, a)
    t.equal(membrane.getOriginSpace(obj), b, 'origin recorded as B, as the caller claimed')

    // a later truthful call does not undo it
    const asA = membrane.bridge(obj, a, b)
    t.equal(membrane.getOriginSpace(obj), b, 'a later correct call does not re-attribute')
    t.equal(asA, obj, 'and B receives it raw, since B is recorded as its home')
    t.end()
  })

  test('origin - a truthful first touch behaves correctly', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const element = { tag: 'a:element' }
    const arr = [element]

    const inB = membrane.bridge(arr, a, b)
    const bridgedElement = membrane.bridge(element, a, b)

    t.equal(membrane.getOriginSpace(element), a, 'origin A')
    t.ok(membrane.isWrapped(bridgedElement), "B's view of the element is a proxy")
    t.equal(inB[0], bridgedElement, 'reading through the array gives the same proxy')
    t.ok(inB.includes(bridgedElement), 'and membership tests agree')
    t.end()
  })

  test('origin - isWrapped distinguishes raw refs, proxies and strangers', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const obj = { tag: 'a:obj' }
    const stranger = { tag: 'never bridged' }

    t.notOk(membrane.isWrapped(obj), 'a never-bridged object is not wrapped')
    t.notOk(membrane.isWrapped(stranger), 'a stranger is not wrapped')
    const proxy = membrane.bridge(obj, a, b)
    t.ok(membrane.isWrapped(proxy), 'the proxy is wrapped')
    t.notOk(membrane.isWrapped(obj), 'the raw ref is still not wrapped after bridging')
    t.notOk(membrane.isWrapped(Object.prototype), 'a primordial is not wrapped')
    t.notOk(membrane.isWrapped(42), 'a primitive is not wrapped')
    t.notOk(membrane.isWrapped(null), 'null is not wrapped')
    t.end()
  })

  test('origin - getOriginSpace agrees for a raw ref and its proxies', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })
    const obj = { tag: 'a:obj' }

    const inB = membrane.bridge(obj, a, b)
    const inC = membrane.bridge(obj, a, c)

    t.equal(membrane.getOriginSpace(obj), a, 'raw ref reports A')
    t.equal(membrane.getOriginSpace(inB), a, "B's proxy reports A")
    t.equal(membrane.getOriginSpace(inC), a, "C's proxy reports A")
    t.equal(membrane.getOriginSpace({ tag: 'unknown' }), undefined, 'a stranger reports undefined')
    t.equal(membrane.getOriginSpace(Object.prototype), undefined, 'a primordial reports undefined')
    t.end()
  })

  test('origin - a distortion cannot be escaped by round tripping', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const c = membrane.makeMembraneSpace({ label: 'c' })
    const skip = skipPrimordialsOf(membrane)

    const target = { value: 'original', nested: { value: 'nested-original' } }
    const inB = membrane.bridge(target, a, b)

    // route B's proxy through C and back, then try to write
    const inC = membrane.bridge(inB, b, c)
    const backInB = membrane.bridge(inC, c, b)
    t.equal(backInB, inB, 'the round trip returns the identical proxy')

    for (const view of [inB, inC, backInB]) {
      try { view.value = 'pwned' } catch (err) { /* strict mode may throw */ }
      try { view.nested.value = 'pwned' } catch (err) { /* strict mode may throw */ }
    }
    t.equal(target.value, 'original', 'no view could write the top level')
    t.equal(target.nested.value, 'nested-original', 'no view could write a nested value')

    helpers.assertNoLeak(t, inC, new Set([target, target.nested]),
      'no view reaches the raw target', { skip })
    t.end()
  })

  // A throw raised while converting an out-graph value into the origin graph is
  // an out-graph value. If the trap's catch bridges it as though the origin
  // graph had raised it, bridge() records `origin: originGraph` for it - and
  // since origin is written once, that forgery is permanent. The guest then
  // holds a reference the membrane believes belongs to the host, so bridging it
  // hands it over raw, and a set with it as receiver writes a raw host
  // reference straight into guest-held state.
  //
  // bridge() runs guest code on that path: choosing a proxy target reads
  // `value.prototype`, which an accessor on the prototype chain can answer with
  // a throw. So the conversions have to happen before the try, not inside it.
  for (const [label, createHandler] of [
    ['the default distortion', undefined],
    ['a readOnly distortion', createReadOnlyDistortion]
  ]) {
    test(`origin - a throw while converting an argument cannot forge origin (${label})`, (t) => {
      const membrane = new Membrane()
      const host = membrane.makeMembraneSpace({ label: 'host', createHandler })
      const guest = membrane.makeMembraneSpace({ label: 'guest' })

      const hostObj = { secret: 'host-owned', stolen: undefined }
      const hostProxy = membrane.bridge(hostObj, host, guest)

      // guest-owned, and what the guest wants the membrane to misattribute
      const smuggled = {}
      const throwingProto = Object.create(Function.prototype)
      Object.defineProperty(throwingProto, 'prototype', {
        get () { throw smuggled }
      })
      // an arrow function has no own "prototype", so the lookup reaches the
      // accessor above while bridge() is picking a proxy target for it
      const trigger = () => {}
      Object.setPrototypeOf(trigger, throwingProto)

      let raised
      try { hostProxy.anything = trigger } catch (err) { raised = err }
      t.ok(raised !== undefined, 'the throw still reaches the guest')

      t.notEqual(membrane.getOriginSpace(smuggled), host,
        'the guest value was not attributed to the host space')

      // and the attribution cannot be cashed in for a raw reference
      try {
        Reflect.set(hostProxy, 'stolen', hostProxy, smuggled)
      } catch (err) { /* a distortion may refuse the write */ }
      t.notEqual(smuggled.stolen, hostObj, 'no raw host reference reached the guest')
      t.equal(hostObj.stolen, undefined, 'and the host object was not written through')
      t.end()
    })
  }
}

function reflectHandler () {
  const handler = {}
  for (const key of Reflect.ownKeys(Reflect)) handler[key] = Reflect[key]
  return handler
}
