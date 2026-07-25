// Shared machinery for the reachability suite.
//
// The guarantee under test is a reachability property, not a per-trap property:
// starting from any value a space legitimately holds, no sequence of ordinary
// JavaScript reads may arrive at a raw reference belonging to another space.
// Asserting that trap-by-trap misses the interesting cases, because a leak is
// usually two hops away - a descriptor's getter, a prototype's method, an
// element of an array returned by a call. So the core tool here is a crawler
// that walks everything reachable and reports any forbidden identity it lands
// on, together with the path it took to get there.

// Values that are shared by design and must never count as a leak: primitives
// carry no identity, and primordials are deliberately passed through.
export function isRef (value) {
  if (value === null) return false
  const type = typeof value
  return type === 'object' || type === 'function'
}

// A tagged object graph. Every node is unique and identifiable, and the graph
// exercises the shapes that have historically carried references across a
// membrane: plain properties, nested objects, arrays, methods, accessors,
// prototypes, and a constructor.
export function makeGraph (label) {
  const refs = new Set()
  const track = (obj) => { refs.add(obj); return obj }

  const leaf = track({ tag: `${label}:leaf`, deep: track({ tag: `${label}:deep` }) })
  const inArray = track({ tag: `${label}:inArray` })
  const arr = track([inArray, track({ tag: `${label}:inArray2` })])
  const accessorValue = track({ tag: `${label}:accessorValue` })
  const methodResult = track({ tag: `${label}:methodResult` })
  const protoValue = track({ tag: `${label}:protoValue` })

  const proto = track({
    tag: `${label}:proto`,
    protoValue,
    protoMethod () { return protoValue }
  })

  const Ctor = track(function Ctor () {
    this.tag = `${label}:instance`
    this.own = track({ tag: `${label}:instanceOwn` })
  })
  Ctor.prototype = track({ tag: `${label}:CtorProto`, ctorProtoValue: track({ tag: `${label}:ctorProtoValue` }) })
  Ctor.prototype.constructor = Ctor

  const method = track(function method () { return methodResult })
  const thrower = track(function thrower () { throw track(new Error(`${label}:thrownError`)) })

  const root = track(Object.create(proto, {
    tag: { value: `${label}:root`, enumerable: true, configurable: true, writable: true },
    leaf: { value: leaf, enumerable: true, configurable: true, writable: true },
    arr: { value: arr, enumerable: true, configurable: true, writable: true },
    method: { value: method, enumerable: true, configurable: true, writable: true },
    thrower: { value: thrower, enumerable: true, configurable: true, writable: true },
    Ctor: { value: Ctor, enumerable: true, configurable: true, writable: true },
    // an accessor, so the crawler has to go through a getter to find the value
    accessor: {
      get () { return accessorValue },
      set (_v) {},
      enumerable: true,
      configurable: true
    },
    // a non-enumerable property, so `for..in` style walks would miss it
    hidden: { value: track({ tag: `${label}:hidden` }), enumerable: false, configurable: true, writable: true }
  }))

  return { label, root, refs, leaf, arr, method, thrower, Ctor, proto, accessorValue, methodResult, protoValue }
}

// Walk everything reachable from `value` and return every reference found,
// along with the first path by which each was reached.
//
// Deliberately aggressive: it reads own properties (via descriptors, so getters
// are seen both as functions and by invocation), the prototype chain, and the
// results of zero-argument calls. Anything that throws is recorded and skipped
// rather than aborting the crawl - a membrane that throws is not leaking.
export function crawl (value, options = {}) {
  const {
    maxNodes = 20000,
    maxDepth = 8,
    invokeFunctions = true,
    invokeGetters = true,
    // Primordials are shared across every space by design, so they are never a
    // leak - and descending into them turns a six-node graph into a walk of the
    // entire realm. Callers pass `membrane.primordials` here.
    skip = defaultSkip
  } = options

  const found = new Map() // ref -> path string
  const errors = []
  const queue = []

  const push = (v, path, depth) => {
    if (!isRef(v)) return
    if (found.has(v)) return
    if (found.size >= maxNodes) return
    found.set(v, path)
    if (skip(v)) return
    if (depth < maxDepth) queue.push({ value: v, path, depth })
  }

  // A call may hand back a promise that rejects (several primordials do). An
  // unhandled rejection would take the process down mid-crawl, so neutralise it
  // the moment it is seen.
  const defuse = (v) => {
    if (isRef(v)) {
      try {
        if (typeof v.then === 'function') v.then(noop, noop)
      } catch { /* a throwing `then` getter is not our problem */ }
    }
    return v
  }

  push(value, '<root>', 0)

  while (queue.length > 0) {
    const { value: current, path, depth } = queue.shift()

    // prototype
    try {
      push(Reflect.getPrototypeOf(current), `${path}.[[Proto]]`, depth + 1)
    } catch (err) { errors.push({ path: `${path}.[[Proto]]`, err }) }

    // own keys + descriptors
    let keys = []
    try {
      keys = Reflect.ownKeys(current)
    } catch (err) { errors.push({ path: `${path}.[[OwnKeys]]`, err }) }

    for (const key of keys) {
      const keyLabel = typeof key === 'symbol' ? `[${String(key)}]` : `.${String(key)}`
      let desc
      try {
        desc = Reflect.getOwnPropertyDescriptor(current, key)
      } catch (err) { errors.push({ path: `${path}${keyLabel}<desc>`, err }); continue }
      if (desc === undefined) continue

      if ('value' in desc) {
        push(desc.value, `${path}${keyLabel}`, depth + 1)
      }
      if (desc.get !== undefined) {
        push(desc.get, `${path}${keyLabel}<getter>`, depth + 1)
        if (invokeGetters) {
          try {
            push(Reflect.get(current, key), `${path}${keyLabel}<get>`, depth + 1)
          } catch (err) { errors.push({ path: `${path}${keyLabel}<get>`, err }) }
        }
      }
      if (desc.set !== undefined) {
        push(desc.set, `${path}${keyLabel}<setter>`, depth + 1)
      }
    }

    // calling things is how a lot of references actually travel
    if (invokeFunctions && typeof current === 'function') {
      try {
        push(defuse(current()), `${path}()`, depth + 1)
      } catch (err) { errors.push({ path: `${path}()`, err }) }
      try {
        push(defuse(Reflect.construct(current, [])), `${path}<new>`, depth + 1)
      } catch (err) { errors.push({ path: `${path}<new>`, err }) }
    }
  }

  return { found, errors }
}

function noop () {}

// Replaced per-call by tests that have a membrane in hand; the default keeps a
// bare `crawl()` from wandering into the realm's own object graph.
let defaultSkipSet = null
export function setDefaultSkipSet (values) {
  defaultSkipSet = values === null ? null : new Set(values)
}
function defaultSkip (v) {
  return defaultSkipSet !== null && defaultSkipSet.has(v)
}

// Convenience: a skip predicate for a given membrane's primordials.
export function skipPrimordialsOf (membrane) {
  const set = new Set(membrane.primordials)
  return (v) => set.has(v)
}

// The assertion the whole suite is built around.
//
// `forbidden` is the set of raw references owned by some other space. If the
// crawl reaches any of them, the membrane has leaked and the path shows how.
export function assertNoLeak (t, value, forbidden, message, options) {
  const { found } = crawl(value, options)
  const leaks = []
  for (const [ref, path] of found) {
    if (forbidden.has(ref)) leaks.push({ ref, path })
  }
  if (leaks.length === 0) {
    t.pass(`${message} (crawled ${found.size} refs, no forbidden identity reached)`)
    return
  }
  const detail = leaks
    .map(({ ref, path }) => `${path} === ${describe(ref)}`)
    .join('\n    ')
  t.fail(`${message} - reached ${leaks.length} forbidden reference(s):\n    ${detail}`)
}

// The converse: something that *should* be reachable, is. Guards against a test
// that passes only because the crawl found nothing at all.
export function assertReaches (t, value, target, message, options) {
  const { found } = crawl(value, options)
  t.ok(found.has(target), `${message} (crawled ${found.size} refs)`)
}

export function describe (ref) {
  try {
    if (typeof ref === 'function') return `<function ${ref.name || 'anonymous'}>`
    if (Array.isArray(ref)) return `<array length ${ref.length}>`
    const tag = ref.tag
    if (typeof tag === 'string') return `<object ${tag}>`
    return `<${typeof ref}>`
  } catch {
    return '<unreadable>'
  }
}

// Counts proxies and identity records so tests can assert the *shape* of what
// the membrane built, not just what it returned.
export function countWrapped (membrane, refs) {
  let wrapped = 0
  for (const ref of refs) {
    if (membrane.isWrapped(ref)) wrapped++
  }
  return wrapped
}
