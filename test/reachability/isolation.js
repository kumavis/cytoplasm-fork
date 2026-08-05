// The primary guarantee: a space must never reach another space's raw reference.
//
// Every test here crawls what a destination space actually holds and asserts that
// none of the origin space's raw references appear anywhere in it - through
// properties, prototypes, descriptors, getters, call results or constructor
// results. The crawl is paired with a positive assertion so a test cannot pass
// merely because nothing was reachable.

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { makeGraph, crawl, assertNoLeak, assertReaches, skipPrimordialsOf } = helpers

  // A membrane plus n labelled spaces, and the skip set for crawling.
  const setup = (labels, opts = {}) => {
    const membrane = new Membrane()
    const spaces = {}
    for (const label of labels) {
      spaces[label] = membrane.makeMembraneSpace({ label, ...(opts[label] || {}) })
    }
    return { membrane, spaces, skip: skipPrimordialsOf(membrane) }
  }

  test('isolation - direct A to B leaks nothing raw', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const g = makeGraph('a')
    const seen = membrane.bridge(g.root, spaces.a, spaces.b)

    assertNoLeak(t, seen, g.refs, 'B reaches no raw reference of A', { skip })
    // and prove the crawl actually went somewhere
    t.notEqual(seen, g.root, 'B holds a proxy, not the raw root')
    t.ok(membrane.isWrapped(seen), 'the value B holds is wrapped')
    t.equal(seen.tag, 'a:root', 'B can still read through it')
    t.equal(seen.leaf.tag, 'a:leaf', 'nested reads work')
    t.equal(seen.arr.length, 2, 'arrays read through')
    t.equal(seen.method().tag, 'a:methodResult', 'call results arrive')
    t.equal(seen.accessor.tag, 'a:accessorValue', 'accessor results arrive')
    t.equal(seen.protoMethod().tag, 'a:protoValue', 'inherited method results arrive')
    t.end()
  })

  test('isolation - every value B reaches is wrapped, not raw', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const g = makeGraph('a')
    const seen = membrane.bridge(g.root, spaces.a, spaces.b)
    const { found } = crawl(seen, { skip })

    let checked = 0
    for (const [ref] of found) {
      if (g.refs.has(ref)) t.fail(`raw reference reachable: ${helpers.describe(ref)}`)
      checked++
    }
    t.ok(checked > 5, `crawl visited a non-trivial graph (${checked} refs)`)
    t.end()
  })

  test('isolation - transitive A to B to C', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b', 'c'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const inC = membrane.bridge(inB, spaces.b, spaces.c)

    assertNoLeak(t, inC, g.refs, 'C reaches no raw reference of A', { skip })
    t.notEqual(inC, inB, 'C gets a distinct proxy from B')
    t.notEqual(inC, g.root, 'C does not get the raw root')
    t.equal(inC.tag, 'a:root', 'C can read through two hops')
    t.equal(inC.leaf.deep.tag, 'a:deep', 'deep reads survive two hops')
    t.end()
  })

  test('isolation - four spaces in a chain', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b', 'c', 'd'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const inC = membrane.bridge(inB, spaces.b, spaces.c)
    const inD = membrane.bridge(inC, spaces.c, spaces.d)

    assertNoLeak(t, inD, g.refs, 'D reaches no raw reference of A', { skip })
    const distinct = new Set([g.root, inB, inC, inD])
    t.equal(distinct.size, 4, 'each space has its own distinct view')
    t.equal(inD.tag, 'a:root', 'readable through three hops')
    t.end()
  })

  test('isolation - a ref fanned out to two spaces keeps them apart', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b', 'c'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const inC = membrane.bridge(g.root, spaces.a, spaces.c)

    t.notEqual(inB, inC, 'B and C get different proxies for the same raw ref')
    assertNoLeak(t, inB, g.refs, 'B reaches nothing raw', { skip })
    assertNoLeak(t, inC, g.refs, 'C reaches nothing raw', { skip })
    // B must not be able to reach C's proxies either
    const cOnly = new Set([inC])
    assertNoLeak(t, inB, cOnly, "B does not reach C's proxy", { skip })
    t.end()
  })

  test('isolation - identity is stable per space', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const g = makeGraph('a')
    const first = membrane.bridge(g.root, spaces.a, spaces.b)
    const second = membrane.bridge(g.root, spaces.a, spaces.b)
    t.equal(first, second, 'bridging twice yields the identical proxy')
    t.equal(first.leaf, second.leaf, 'nested reads are identity-stable too')
    t.equal(first.leaf, first.leaf, 'repeated reads of the same property match')
    t.equal(first.method, first.method, 'methods are identity-stable')
    t.end()
  })

  test('isolation - a ref returns home unwrapped', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const home = membrane.bridge(inB, spaces.b, spaces.a)
    t.equal(home, g.root, 'A receives its own object raw, not a proxy of it')
    t.notOk(membrane.isWrapped(home), 'and it is not reported as wrapped')
    t.end()
  })

  test('isolation - objects created in B stay B-owned when passed to A', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const bOwned = { tag: 'b:owned', child: { tag: 'b:child' } }
    const bRefs = new Set([bOwned, bOwned.child])
    const inA = membrane.bridge(bOwned, spaces.b, spaces.a)

    assertNoLeak(t, inA, bRefs, "A reaches no raw reference of B", { skip })
    t.equal(membrane.getOriginSpace(bOwned), spaces.b, 'origin recorded as B')
    t.equal(membrane.bridge(inA, spaces.a, spaces.b), bOwned, 'and it goes home raw')
    t.end()
  })

  test('isolation - values passed as call arguments are bridged both ways', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    let received
    const aFn = (x) => { received = x; return { tag: 'a:returned', got: x } }
    const aRefs = new Set([aFn])
    const inB = membrane.bridge(aFn, spaces.a, spaces.b)

    const bArg = { tag: 'b:arg' }
    const result = inB(bArg)

    t.notEqual(received, bArg, "A does not receive B's raw argument")
    t.ok(membrane.isWrapped(received), "A receives a wrapped view of B's argument")
    t.equal(received.tag, 'b:arg', 'and can read it')
    assertNoLeak(t, result, aRefs, 'the returned object leaks nothing raw from A', { skip })
    // the argument must come back out as B's own raw object, not a double wrap
    t.equal(result.got, bArg, "B sees its own object identically on the way back")
    t.end()
  })

  test('isolation - constructor results are bridged', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const g = makeGraph('a')
    const Ctor = membrane.bridge(g.Ctor, spaces.a, spaces.b)
    const instance = new Ctor()

    t.ok(membrane.isWrapped(instance), 'the instance arrives wrapped')
    t.equal(instance.tag, 'a:instance', 'and is readable')
    assertNoLeak(t, instance, g.refs, 'the instance leaks nothing raw', { skip })
    t.end()
  })

  test('isolation - thrown errors do not carry raw references', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const g = makeGraph('a')
    const thrower = membrane.bridge(g.thrower, spaces.a, spaces.b)
    let caught
    try { thrower() } catch (err) { caught = err }

    t.ok(caught !== undefined, 'the call threw')
    t.ok(membrane.isWrapped(caught), 'the error arrives wrapped')
    t.equal(caught.message, 'a:thrownError', 'the message survives')
    assertNoLeak(t, caught, g.refs, 'the error leaks no raw reference', { skip })
    t.end()
  })

  test('isolation - prototype chains stay inside their space', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const proto = Object.getPrototypeOf(inB)

    t.notEqual(proto, g.proto, 'B does not get the raw prototype')
    t.ok(membrane.isWrapped(proto), 'the prototype arrives wrapped')
    assertNoLeak(t, proto, g.refs, 'the prototype leaks nothing raw', { skip })
    assertReaches(t, inB, proto, 'the wrapped prototype is genuinely reachable', { skip })
    t.end()
  })

  test('isolation - two membranes over the same object stay independent', (t) => {
    const m1 = new Membrane()
    const m2 = new Membrane()
    const shared = { tag: 'shared', child: { tag: 'shared:child' } }
    const refs = new Set([shared, shared.child])

    const a1 = m1.makeMembraneSpace({ label: 'a' })
    const b1 = m1.makeMembraneSpace({ label: 'b' })
    const a2 = m2.makeMembraneSpace({ label: 'a' })
    const b2 = m2.makeMembraneSpace({ label: 'b' })

    const view1 = m1.bridge(shared, a1, b1)
    const view2 = m2.bridge(shared, a2, b2)

    t.notEqual(view1, view2, 'each membrane makes its own proxy')
    assertNoLeak(t, view1, refs, 'membrane 1 leaks nothing raw', { skip: skipPrimordialsOf(m1) })
    assertNoLeak(t, view2, refs, 'membrane 2 leaks nothing raw', { skip: skipPrimordialsOf(m2) })
    t.notOk(m2.isWrapped(view1), "membrane 2 does not recognise membrane 1's proxy")
    t.end()
  })

  test('isolation - deeply nested graphs stay wrapped all the way down', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const refs = new Set()
    let deepest = { tag: 'a:bottom' }
    refs.add(deepest)
    for (let i = 0; i < 25; i++) {
      deepest = { tag: `a:level${i}`, next: deepest }
      refs.add(deepest)
    }
    const inB = membrane.bridge(deepest, spaces.a, spaces.b)

    let cursor = inB
    let depth = 0
    while (cursor && cursor.next) {
      t.notOk(refs.has(cursor), `level ${depth} is not a raw reference`)
      cursor = cursor.next
      depth++
    }
    // 26 objects, 25 of which carry a `next`; the loop stops on the bottom one
    t.equal(depth, 25, 'walked the whole chain')
    assertNoLeak(t, inB, refs, 'no level of a 26-deep chain leaks', { skip, maxDepth: 30 })
    t.end()
  })

  test('isolation - symbol-keyed properties are bridged', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const key = Symbol('secretKey')
    const hidden = { tag: 'a:behindSymbol' }
    const obj = { [key]: hidden }
    const refs = new Set([obj, hidden])
    const inB = membrane.bridge(obj, spaces.a, spaces.b)

    t.notEqual(inB[key], hidden, 'the symbol-keyed value is not raw')
    t.ok(membrane.isWrapped(inB[key]), 'it is wrapped')
    t.equal(inB[key].tag, 'a:behindSymbol', 'and readable')
    assertNoLeak(t, inB, refs, 'symbol-keyed values leak nothing raw', { skip })
    t.end()
  })

  test('isolation - getters that return foreign objects are bridged', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'b'])
    const secret = { tag: 'a:viaGetter' }
    const obj = { get secret () { return secret } }
    const refs = new Set([obj, secret])
    const inB = membrane.bridge(obj, spaces.a, spaces.b)

    t.notEqual(inB.secret, secret, 'the getter result is not raw')
    t.ok(membrane.isWrapped(inB.secret), 'it is wrapped')
    t.equal(inB.secret, inB.secret, 'and is identity-stable across reads')
    assertNoLeak(t, inB, refs, 'getter results leak nothing raw', { skip })
    t.end()
  })

  test('isolation - a raw ref reached only through a descriptor is bridged', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const inner = { tag: 'a:inDescriptor' }
    const obj = {}
    Object.defineProperty(obj, 'x', { value: inner, enumerable: true, configurable: true })
    const inB = membrane.bridge(obj, spaces.a, spaces.b)
    const desc = Object.getOwnPropertyDescriptor(inB, 'x')

    t.notEqual(desc.value, inner, 'the descriptor value is not raw')
    t.ok(membrane.isWrapped(desc.value), 'it is wrapped')
    t.equal(desc.value.tag, 'a:inDescriptor', 'and readable')
    t.end()
  })

  test('isolation - alwaysUnwrap is the documented opt-out, and only for that space', (t) => {
    const { membrane, spaces, skip } = setup(['a', 'u', 'c'], { u: { dangerouslyAlwaysUnwrap: true } })
    const g = makeGraph('a')
    const inU = membrane.bridge(g.root, spaces.a, spaces.u)
    t.equal(inU, g.root, 'U receives the raw reference by explicit opt-in')

    // but a normal space must still be isolated from the same object
    const inC = membrane.bridge(g.root, spaces.a, spaces.c)
    t.notEqual(inC, g.root, 'C still gets a proxy')
    assertNoLeak(t, inC, g.refs, 'the opt-out does not weaken other spaces', { skip })
    t.end()
  })

  test('isolation - passthroughFilter is scoped to what it matches', (t) => {
    const membrane = new Membrane()
    const passed = { tag: 'a:passed' }
    const notPassed = { tag: 'a:notPassed' }
    const a = membrane.makeMembraneSpace({ label: 'a' })
    const b = membrane.makeMembraneSpace({
      label: 'b',
      passthroughFilter: (ref) => ref === passed
    })

    t.equal(membrane.bridge(passed, a, b), passed, 'the matched ref passes through raw')
    t.notEqual(membrane.bridge(notPassed, a, b), notPassed, 'an unmatched ref is still wrapped')
    t.ok(membrane.isWrapped(membrane.bridge(notPassed, a, b)), 'and reported wrapped')
    t.end()
  })
}
