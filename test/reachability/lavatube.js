// Reachability, checked with LavaMoat's LavaTube.
//
// The hand-rolled crawler in helpers.js and LavaTube are answering the same
// question - "what can be reached from here" - and LavaTube answers it more
// thoroughly. Measured against the same bridged graph it reaches 243 references
// where the local crawler reaches 26, because it enumerates the whole prototype
// chain's keys (marking shadowed ones), walks iterables, and can brute-force
// WeakMaps. Everything the local crawler traverses, LavaTube traverses too; the
// only references the local one reported that LavaTube did not were raw
// primordials, which LavaTube deliberately excludes through shouldWalk, and
// freshly constructed objects, which have a new identity on every call and so
// cannot be compared by identity at all.
//
// So this module states the isolation guarantee in LavaTube's terms:
//
//   find(bridgedValue, someOtherSpacesRawRef) === undefined
//
// which is a stronger statement than the local crawler can make, and comes with
// a path when it fails.
//
// The published package declares no "main" and no "exports", so the bare
// specifier does not resolve; the source entry point is imported directly.

import { find, walk, getAllValues } from '@lavamoat/lavatube/src/index.js'
import createReadOnlyDistortion from '../../src/distortions/readOnly.js'

export default function run (test, exports, helpers) {
  const { Membrane } = exports
  const { makeGraph } = helpers

  // LavaTube configured to match what the membrane cares about: getters
  // invoked, functions called and constructed, primordials left alone.
  const options = (membrane, extra = {}) => {
    const primordials = new Set(membrane.primordials)
    return {
      shouldInvokeGetters: true,
      shouldCallFunctions: true,
      shouldConstructFunctions: true,
      shouldWalk: (value) => !primordials.has(value),
      maxDepth: 12,
      ...extra
    }
  }

  const setup = (labels, opts = {}) => {
    const membrane = new Membrane()
    const spaces = {}
    for (const label of labels) {
      spaces[label] = membrane.makeMembraneSpace({ label, ...(opts[label] || {}) })
    }
    return { membrane, spaces }
  }

  // Assert that none of a set of raw references is reachable, reporting the
  // path LavaTube took if one is.
  const assertUnreachable = (t, membrane, from, rawRefs, message) => {
    const opts = options(membrane)
    // snapshot: the walk constructs functions it finds, and a live Set that
    // grew during iteration would never terminate
    const targets = [...rawRefs]
    for (const raw of targets) {
      const path = find(from, raw, opts)
      if (path !== undefined) {
        t.fail(`${message} - reached ${helpers.describe(raw)} via [${path.map(String).join(' -> ')}]`)
        return
      }
    }
    t.pass(`${message} (${targets.length} raw references, none reachable)`)
  }

  //
  // the guarantee, in LavaTube's terms
  //

  test('lavatube - find cannot reach any raw reference of another space', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const g = makeGraph('a')
    const bridged = membrane.bridge(g.root, spaces.a, spaces.b)

    assertUnreachable(t, membrane, bridged, g.refs, 'B reaches no raw reference of A')

    // non-vacuous: the walk really did traverse a substantial graph
    const values = getAllValues(bridged, options(membrane))
    t.ok(values.length > 50, `the walk visited a real graph (${values.length} values)`)
    t.ok(values.includes(bridged), 'including the value it started from')
    t.end()
  })

  test('lavatube - positive control: an alwaysUnwrap space IS reachable', (t) => {
    const { membrane, spaces } = setup(['a', 'u'], { u: { dangerouslyAlwaysUnwrap: true } })
    const inner = { tag: 'a:inner' }
    const handed = membrane.bridge({ nested: inner }, spaces.a, spaces.u)

    const path = find(handed, inner, options(membrane))
    t.notEqual(path, undefined, 'find locates a genuinely leaked reference')
    t.deepEqual(path && path.map(String), ['nested'], 'and reports the path it took')
    t.end()
  })

  test('lavatube - positive control: find locates the bridged equivalent', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const inner = { tag: 'a:inner' }
    const bridged = membrane.bridge({ nested: inner }, spaces.a, spaces.b)

    t.equal(find(bridged, inner, options(membrane)), undefined, 'the raw reference is unreachable')
    const bridgedInner = bridged.nested
    t.notEqual(find(bridged, bridgedInner, options(membrane)), undefined,
      'but the bridged equivalent is reachable, so the search is working')
    t.end()
  })

  test('lavatube - transitive routing stays isolated', (t) => {
    const { membrane, spaces } = setup(['a', 'b', 'c', 'd'])
    const g = makeGraph('a')
    const inB = membrane.bridge(g.root, spaces.a, spaces.b)
    const inC = membrane.bridge(inB, spaces.b, spaces.c)
    const inD = membrane.bridge(inC, spaces.c, spaces.d)

    assertUnreachable(t, membrane, inD, g.refs, 'D reaches no raw reference of A after three hops')
    t.ok(getAllValues(inD, options(membrane)).length > 50, 'and the walk was non-trivial')
    t.end()
  })

  test('lavatube - the laundering attack leaves nothing reachable', (t) => {
    const membrane = new Membrane()
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
    const u = membrane.makeMembraneSpace({ label: 'u', dangerouslyAlwaysUnwrap: true })
    const c = membrane.makeMembraneSpace({ label: 'c' })

    const secret = { value: 'original', nested: { value: 'nested' } }
    const inU = membrane.bridge(secret, a, u)
    const inC = membrane.bridge(inU, u, c)

    assertUnreachable(t, membrane, inC, new Set([secret, secret.nested]),
      'the third space reaches no raw reference of the origin space')
    t.notEqual(inC, secret, 'and holds a proxy')
    t.end()
  })

  test('lavatube - deep graphs stay isolated all the way down', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const refs = new Set()
    let node = { tag: 'a:bottom' }
    refs.add(node)
    for (let i = 0; i < 10; i++) {
      node = { tag: `a:level${i}`, next: node }
      refs.add(node)
    }
    const bridged = membrane.bridge(node, spaces.a, spaces.b)

    assertUnreachable(t, membrane, bridged, refs, 'no level of the chain is reachable raw')
    // and the bottom really is reachable in its bridged form
    let cursor = bridged
    while (cursor.next) cursor = cursor.next
    t.equal(cursor.tag, 'a:bottom', 'the walk target genuinely exists at the bottom')
    t.notEqual(find(bridged, cursor, options(membrane)), undefined, 'and is findable in bridged form')
    t.end()
  })

  test('lavatube - a function returning a foreign object leaks nothing', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const hidden = { tag: 'a:hidden' }
    const obj = { reveal: () => hidden }
    const bridged = membrane.bridge(obj, spaces.a, spaces.b)

    // shouldCallFunctions is on, so LavaTube calls reveal() during the walk
    assertUnreachable(t, membrane, bridged, new Set([obj, hidden]),
      'calling functions during the walk does not surface a raw reference')
    t.notEqual(find(bridged, bridged.reveal(), options(membrane)), undefined,
      'though the bridged result is reachable')
    t.end()
  })

  //
  // channels LavaTube walks that the local crawler does not
  //

  test('lavatube - entries of a Map crossing the membrane are bridged', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const inner = { tag: 'a:inMap' }
    const map = new Map([['key', inner]])
    const bridged = membrane.bridge(map, spaces.a, spaces.b)

    t.notEqual(bridged.get('key'), inner, 'Map.get returns a bridged value, not the raw one')
    t.ok(membrane.isWrapped(bridged.get('key')), 'and it is wrapped')
    assertUnreachable(t, membrane, bridged, new Set([map, inner]),
      'walking the Map as an iterable surfaces no raw reference')
    t.ok(getAllValues(bridged, options(membrane)).length > 10, 'the Map walk was non-trivial')
    t.end()
  })

  test('lavatube - members of a Set crossing the membrane are bridged', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const inner = { tag: 'a:inSet' }
    const set = new Set([inner])
    const bridged = membrane.bridge(set, spaces.a, spaces.b)

    assertUnreachable(t, membrane, bridged, new Set([set, inner]),
      'walking the Set as an iterable surfaces no raw reference')
    t.end()
  })

  test('lavatube - brute-forcing WeakMaps surfaces nothing', (t) => {
    const { membrane, spaces } = setup(['a', 'b'])
    const inner = { tag: 'a:inWeakMap' }
    const keyObj = { tag: 'a:weakKey' }
    const weak = new WeakMap([[keyObj, inner]])
    const holder = { weak, keyObj }
    const bridged = membrane.bridge(holder, spaces.a, spaces.b)

    const opts = options(membrane, { shouldBruteForceWeakMaps: true })
    for (const raw of [holder, weak, keyObj, inner]) {
      t.equal(find(bridged, raw, opts), undefined,
        `${helpers.describe(raw)} is unreachable even with WeakMap brute force`)
    }
    t.end()
  })

  test('lavatube - walk can halt on the first forbidden reference', (t) => {
    const { membrane, spaces } = setup(['a', 'u'], { u: { dangerouslyAlwaysUnwrap: true } })
    const inner = { tag: 'a:inner' }
    const handed = membrane.bridge({ nested: inner }, spaces.a, spaces.u)

    const result = walk(handed, (value) => value === inner, options(membrane))
    t.notEqual(result, undefined, 'walk found the leaked reference')
    t.equal(result.value, inner, 'and returned it')
    t.ok(Array.isArray(result.path), 'with a path')
    t.end()
  })

  //
  // The one capability the local crawler has that LavaTube does not.
  //
  // LavaTube wraps every reflective operation in a try/catch that degrades
  // silently - ownKeys becomes [], getPrototypeOf becomes null, get becomes
  // undefined. That is the right call for a general-purpose walker, but it
  // means a walk that was entirely BLOCKED and a walk that found nothing are
  // indistinguishable, and "no forbidden reference reachable" is exactly the
  // assertion that must not be allowed to pass vacuously.
  //
  // The local crawler records the path of every operation that threw, so a
  // test can prove the membrane actively refused rather than that the graph
  // was empty. Only that distinction is reproduced here.
  //
  test('lavatube gap - blocked and absent are distinguishable locally', (t) => {
    const membrane = new Membrane()
    const alwaysThrow = () => {
      const handler = {}
      for (const key of Reflect.ownKeys(Reflect)) {
        handler[key] = () => { throw new Error('blocked') }
      }
      return handler
    }
    const a = membrane.makeMembraneSpace({ label: 'a', createHandler: alwaysThrow })
    const b = membrane.makeMembraneSpace({ label: 'b' })
    const g = makeGraph('a')
    const blocked = membrane.bridge(g.root, a, b)

    // LavaTube reports no leak - but so would an empty object
    t.equal(find(blocked, g.root, options(membrane)), undefined,
      'LavaTube reports the raw root unreachable')

    // the local crawler says WHY: the operations threw
    const crawled = helpers.crawl(blocked, { skip: helpers.skipPrimordialsOf(membrane) })
    t.ok(crawled.errors.length > 0,
      `the traversal was actively blocked, not empty (${crawled.errors.length} operations threw)`)
    t.ok(crawled.errors.some((e) => e.path.includes('[[OwnKeys]]')), 'ownKeys was refused')
    t.ok(crawled.errors.some((e) => e.path.includes('[[Proto]]')), 'getPrototypeOf was refused')

    // and the contrast: an ordinary bridged graph traverses without errors
    const openMembrane = new Membrane()
    const oa = openMembrane.makeMembraneSpace({ label: 'a' })
    const ob = openMembrane.makeMembraneSpace({ label: 'b' })
    const open = openMembrane.bridge({ x: 1, y: { z: 2 } }, oa, ob)
    const openCrawl = helpers.crawl(open, { skip: helpers.skipPrimordialsOf(openMembrane) })
    t.equal(openCrawl.errors.length, 0, 'an unobstructed graph records no refusals')
    t.ok(openCrawl.found.size > 1, 'and reaches more than it started with')
    t.end()
  })
}
