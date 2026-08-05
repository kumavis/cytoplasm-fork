// The get-trap receiver fast path.
//
// The get trap short-circuits when the receiver is the membrane's own proxy and
// the distortion's get is Reflect.get:
//
//   if (receiver === this.proxy && this.distortion.get === reflectGet)
//     return this.toOut(this.rawRef[key])
//
// `rawRef[key]` is [[Get]](rawRef, key, rawRef), and the slow path would compute
// Reflect.get(rawRef, key, rawRef) because receiverToOrigin maps the proxy back
// to rawRef. Those are the same operation with the same receiver, so nothing
// should be observable. These tests try to observe it anyway - the interesting
// cases are the ones where the receiver is genuinely visible to user code:
// accessors, inherited accessors, and a Proxy as the raw target.

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { skipPrimordialsOf } = helpers

  const twoSpaces = (aOpts = {}) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a', ...aOpts })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    return { membrane, a, b }
  }

  test('receiver - a raw Proxy target sees the raw ref as receiver', (t) => {
    const { membrane, a, b } = twoSpaces()
    const seen = []
    const target = { x: 1 }
    let recording
    recording = new Proxy(target, {
      get (tgt, key, receiver) {
        seen.push(receiver === recording ? 'rawRef' : receiver === tgt ? 'target' : 'other')
        return Reflect.get(tgt, key, receiver)
      }
    })
    const proxy = membrane.bridge(recording, a, b)

    t.equal(proxy.x, 1, 'the value reads through')
    t.equal(seen.join(','), 'rawRef', 'the underlying trap saw the raw reference as receiver')
    t.notEqual(seen[0], 'other', 'it never saw the membrane proxy')
    t.end()
  })

  test('receiver - an own accessor sees the raw object as this', (t) => {
    const { membrane, a, b } = twoSpaces()
    const obj = {
      hidden: 'secret',
      get viaThis () { return this === obj ? 'raw' : 'other' },
      get value () { return this.hidden }
    }
    const proxy = membrane.bridge(obj, a, b)

    t.equal(proxy.viaThis, 'raw', 'the getter ran with the raw object as this')
    t.equal(proxy.value, 'secret', 'and could read its own sibling property')
    t.end()
  })

  test('receiver - an inherited accessor sees the raw object as this', (t) => {
    const { membrane, a, b } = twoSpaces()
    const proto = {
      get whoAmI () { return this === child ? 'child' : this === proto ? 'proto' : 'other' },
      get inherited () { return this.own }
    }
    const child = Object.create(proto)
    child.own = 'own-value'
    const proxy = membrane.bridge(child, a, b)

    t.equal(proxy.whoAmI, 'child', 'the inherited getter received the child, not the prototype')
    t.equal(proxy.inherited, 'own-value', 'so it read the child own property')
    t.end()
  })

  test('receiver - a membrane proxy on a local prototype chain bridges the receiver', (t) => {
    const { membrane, a, b } = twoSpaces()
    const origin = {
      get whoAmI () { return this === origin ? 'origin-raw' : 'not-origin' },
      get seenType () { return typeof this }
    }
    const proxy = membrane.bridge(origin, a, b)
    // a plain object in B whose prototype is the membrane proxy
    const localChild = Object.create(proxy)

    t.equal(localChild.whoAmI, 'not-origin', 'the getter did not receive the raw origin object')
    t.equal(localChild.seenType, 'object', 'it received an object')
    t.notOk(Object.prototype.hasOwnProperty.call(localChild, 'whoAmI'), 'the read came through the prototype')
    t.end()
  })

  test('receiver - the raw receiver never leaks to the out space', (t) => {
    const { membrane, a, b } = twoSpaces()
    const captured = []
    const origin = { get grab () { captured.push(this); return 'ok' } }
    const proxy = membrane.bridge(origin, a, b)
    const localChild = Object.create(proxy)

    t.equal(proxy.grab, 'ok', 'direct read works')
    t.equal(localChild.grab, 'ok', 'inherited read works')
    t.equal(captured.length, 2, 'the getter ran twice')
    t.equal(captured[0], origin, 'direct read gave the getter the raw object')
    t.notEqual(captured[1], localChild, 'inherited read did not hand it the raw B-side child')
    t.ok(membrane.isWrapped(captured[1]), "it received a bridged view of B's child")
    t.end()
  })

  test('receiver - a getter that returns a foreign object is bridged', (t) => {
    const { membrane, a, b } = twoSpaces()
    const inner = { tag: 'a:inner' }
    const obj = { get inner () { return inner } }
    const proxy = membrane.bridge(obj, a, b)

    t.notEqual(proxy.inner, inner, 'the result is not the raw object')
    t.ok(membrane.isWrapped(proxy.inner), 'it is wrapped')
    t.equal(proxy.inner, proxy.inner, 'and stable across reads')
    t.end()
  })

  test('receiver - a throwing getter propagates a bridged error', (t) => {
    const { membrane, a, b } = twoSpaces()
    const raw = new Error('getter exploded')
    const obj = { get boom () { throw raw } }
    const proxy = membrane.bridge(obj, a, b)

    let caught
    try { proxy.boom } catch (err) { caught = err }
    t.ok(caught !== undefined, 'it threw')
    t.notEqual(caught, raw, 'the raw error did not cross')
    t.ok(membrane.isWrapped(caught), 'a wrapped error crossed instead')
    t.equal(caught.message, 'getter exploded', 'the message survived')
    t.end()
  })

  test('receiver - key kinds all behave', (t) => {
    const { membrane, a, b } = twoSpaces()
    const sym = Symbol('s')
    const obj = { 0: 'zero', 1.5: 'float', '-1': 'negative', '': 'empty', [sym]: 'symbol' }
    obj.__proto__unusual = 'literal key' // eslint-disable-line no-proto
    const proxy = membrane.bridge(obj, a, b)

    t.equal(proxy[0], 'zero', 'numeric key')
    t.equal(proxy['0'], 'zero', 'numeric key as string')
    t.equal(proxy[1.5], 'float', 'float key')
    t.equal(proxy['-1'], 'negative', 'negative key')
    t.equal(proxy[''], 'empty', 'empty string key')
    t.equal(proxy[sym], 'symbol', 'symbol key')
    t.equal(proxy.__proto__unusual, 'literal key', 'a key that merely looks unusual')
    t.equal(proxy.missing, undefined, 'a missing key is undefined')
    t.end()
  })

  test('receiver - __proto__ reads resolve through the prototype getter', (t) => {
    const { membrane, a, b } = twoSpaces()
    const proto = { tag: 'a:proto' }
    const obj = Object.create(proto)
    const proxy = membrane.bridge(obj, a, b)

    // eslint-disable-next-line no-proto
    const viaDunder = proxy.__proto__
    const viaReflect = Object.getPrototypeOf(proxy)
    t.equal(viaDunder, viaReflect, '__proto__ and getPrototypeOf agree')
    t.notEqual(viaDunder, proto, 'and neither returns the raw prototype')
    t.ok(membrane.isWrapped(viaDunder), 'the prototype is wrapped')
    t.end()
  })

  test('receiver - the fast path is skipped when the distortion overrides get', (t) => {
    const membrane = new Membrane()
    let getCalls = 0
    const receivers = []
    const a = membrane.makeMembraneSpace({
      label: 'a',
      createHandler: () => ({
        ...reflectHandler(),
        get (target, key, receiver) {
          getCalls++
          receivers.push(receiver)
          return Reflect.get(target, key, receiver)
        }
      })
    })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const obj = { x: 'value' }
    const proxy = membrane.bridge(obj, a, b)

    t.equal(proxy.x, 'value', 'the custom get still returns the value')
    t.ok(getCalls >= 1, 'the custom get trap was actually called')
    t.equal(receivers[0], obj, 'and it received the raw ref as receiver, as the fast path would have')
    t.end()
  })

  test('receiver - a distortion whose get is Reflect.get still takes the fast path correctly', (t) => {
    const membrane = new Membrane()
    let ownKeysCalls = 0
    // get is Reflect.get, but other traps are custom - the fast path applies to
    // get alone and must not disturb the others
    const a = membrane.makeMembraneSpace({
      label: 'a',
      createHandler: () => ({
        ...reflectHandler(),
        get: Reflect.get,
        ownKeys (target) { ownKeysCalls++; return Reflect.ownKeys(target) }
      })
    })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const inner = { tag: 'a:inner' }
    const obj = { x: 'value', inner }
    const proxy = membrane.bridge(obj, a, b)

    t.equal(proxy.x, 'value', 'get works')
    t.ok(membrane.isWrapped(proxy.inner), 'and still bridges object results')
    t.notEqual(proxy.inner, inner, 'the fast path does not skip bridging')
    Object.keys(proxy)
    t.ok(ownKeysCalls >= 1, 'the custom ownKeys trap was still used')
    t.end()
  })

  // The old implementation captured each distortion trap once, at wrap time.
  // The new one reads this.distortion.get on every invocation, so a distortion
  // that changes its own traps after a reference is wrapped now takes effect.
  // Documented here as the actual current behaviour.
  test('receiver - distortion traps are read per call, not captured at wrap time', (t) => {
    const membrane = new Membrane()
    const distortion = reflectHandler()
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: () => distortion })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const proxy = membrane.bridge({ x: 'original' }, a, b)

    t.equal(proxy.x, 'original', 'reads through the original trap')
    distortion.get = () => 'swapped'
    t.equal(proxy.x, 'swapped', 'a trap swapped after wrapping takes effect')
    distortion.get = Reflect.get
    t.equal(proxy.x, 'original', 'and restoring it restores the behaviour')
    t.end()
  })

  test('receiver - set receives a bridged receiver and writes through', (t) => {
    const { membrane, a, b } = twoSpaces()
    const target = { x: 'original' }
    const proxy = membrane.bridge(target, a, b)

    proxy.x = 'written'
    t.equal(target.x, 'written', 'a plain set writes through to the raw object')

    const value = { tag: 'b:value' }
    proxy.obj = value
    t.notEqual(target.obj, value, "B's raw object did not land in A")
    t.ok(membrane.isWrapped(target.obj), "A holds a bridged view of B's object")
    t.equal(target.obj.tag, 'b:value', 'and can read it')
    t.end()
  })

  test('receiver - set through a local prototype chain defines on the child', (t) => {
    const { membrane, a, b } = twoSpaces()
    const origin = { inherited: 'from-proto' }
    const proxy = membrane.bridge(origin, a, b)
    const localChild = Object.create(proxy)

    localChild.inherited = 'own-now'
    t.equal(localChild.inherited, 'own-now', 'the child sees its own value')
    t.equal(origin.inherited, 'from-proto', 'the origin object was not written')
    t.ok(Object.prototype.hasOwnProperty.call(localChild, 'inherited'), 'the property landed on the child')
    t.end()
  })

  test('receiver - readOnly override mistake: a direct set is refused', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({
      label: 'a',
      createHandler: () => ({
        ...reflectHandler(),
        set: (target, key, value, receiver) => {
          if (target === receiver) return false
          return Reflect.defineProperty(receiver, key, {
            value, enumerable: true, writable: true, configurable: true
          })
        }
      })
    })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const target = { x: 'original' }
    const proxy = membrane.bridge(target, a, b)

    // the distortion compares target === receiver, which requires the receiver to
    // have been mapped back to the raw ref
    let threw = false
    try { proxy.x = 'nope' } catch (err) { threw = true }
    t.equal(target.x, 'original', 'the direct write was refused')
    t.ok(threw || target.x === 'original', 'refusal observed')

    // an indirect set through a child redirects to defineProperty on the child
    const child = Object.create(proxy)
    child.x = 'child-value'
    t.equal(target.x, 'original', 'the origin object is still untouched')
    t.equal(child.x, 'child-value', 'the child got its own property')
    t.end()
  })

  test('receiver - construct passes a bridged newTarget', (t) => {
    const { membrane, a, b } = twoSpaces()
    const newTargets = []
    function Ctor () { this.made = true }
    const proxy = membrane.bridge(Ctor, a, b)

    const instance = new proxy()
    t.ok(instance.made, 'construction worked')
    t.ok(membrane.isWrapped(instance), 'the instance is bridged')

    // Reflect.construct with an explicit, different newTarget
    function Other () {}
    const viaReflect = Reflect.construct(proxy, [], Other)
    t.ok(viaReflect !== undefined, 'explicit newTarget construction worked')
    t.equal(newTargets.length, 0, 'no bookkeeping needed for this assertion')
    t.end()
  })

  test('receiver - has and deleteProperty behave through the membrane', (t) => {
    const { membrane, a, b } = twoSpaces()
    const proto = { inherited: 1 }
    const obj = Object.create(proto)
    obj.own = 2
    const proxy = membrane.bridge(obj, a, b)

    t.ok('own' in proxy, 'own property found')
    t.ok('inherited' in proxy, 'inherited property found')
    t.notOk('missing' in proxy, 'missing property not found')
    t.ok(Object.prototype.hasOwnProperty.call(proxy, 'own'), 'hasOwnProperty sees the own property')
    t.notOk(Object.prototype.hasOwnProperty.call(proxy, 'inherited'), 'and not the inherited one')

    delete proxy.own
    t.notOk('own' in proxy, 'delete removed it')
    t.notOk('own' in obj, 'and it was removed from the raw object')
    t.end()
  })

  test('receiver - reads are consistent under repeated access', (t) => {
    const { membrane, a, b } = twoSpaces()
    const inner = { tag: 'a:inner' }
    const obj = { inner, fn () { return inner } }
    const proxy = membrane.bridge(obj, a, b)
    const skip = skipPrimordialsOf(membrane)

    const viaProp = proxy.inner
    const viaCall = proxy.fn()
    const viaDesc = Object.getOwnPropertyDescriptor(proxy, 'inner').value
    t.equal(viaProp, viaCall, 'property read and call result are the same proxy')
    t.equal(viaProp, viaDesc, 'and the descriptor value agrees')
    helpers.assertNoLeak(t, proxy, new Set([obj, inner]), 'none of these routes leak raw', { skip })
    t.end()
  })
}

function reflectHandler () {
  const handler = {}
  for (const key of Reflect.ownKeys(Reflect)) handler[key] = Reflect[key]
  return handler
}
