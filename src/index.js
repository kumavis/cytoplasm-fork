// theres some things we may need to enforce differently when in and out of strict mode
// e.g. fn.arguments
import { getPrimordialValues, getPrimordialSet } from './getIntrinsics.js'

const { isArray } = Array
// captured so the get trap can recognise an undistorted read without reading
// through Reflect on every call
const reflectGet = Reflect.get


export class MembraneSpace {
  constructor ({ label, createHandler, dangerouslyAlwaysUnwrap, passthroughFilter }) {
    this.alwaysUnwrap = Boolean(dangerouslyAlwaysUnwrap)
    this.rawToBridged = new WeakMap()
    this.handlerForRef = new WeakMap()
    this.label = label
    this.createHandler = createHandler || (() => Reflect)
    this.hasCustomCreateHandler = Boolean(createHandler)
    // A distortion factory can declare itself shareable when the handler it
    // returns keeps no per-ref state - it receives the ref explicitly through
    // setHandlerForRef and through every trap. Then one handler serves the
    // whole space instead of one being built per wrapped ref.
    this.hasSharedHandler = Boolean(createHandler && createHandler.shareable === true)
    this.sharedHandler = undefined
    this.passthroughFilter = passthroughFilter || (() => false)
    // most spaces have no filter, and bridge() runs on every trap argument and
    // every trap result, so it is worth not calling a function to learn "no"
    this.hasPassthroughFilter = Boolean(passthroughFilter)
    // built once per space rather than once per wrapped ref
    this.createHandlerOptions = {
      setHandlerForRef: (ref, newHandler) => this.handlerForRef.set(ref, newHandler)
    }
  }

  getHandlerForRef (rawRef) {
    // this read stays unconditional: user code may seed handlerForRef for a
    // specific ref on a space that has no createHandler of its own
    const existing = this.handlerForRef.get(rawRef)
    if (existing !== undefined) {
      return existing
    }
    if (!this.hasCustomCreateHandler) {
      // the default distortion is Reflect itself, so there is nothing per-ref
      // to build and nothing worth caching
      return Reflect
    }
    if (this.hasSharedHandler) {
      if (this.sharedHandler === undefined) {
        this.sharedHandler = this.createHandler(this.createHandlerOptions)
      }
      return this.sharedHandler
    }
    const handler = this.createHandler(this.createHandlerOptions)
    this.handlerForRef.set(rawRef, handler)
    return handler
  }
}

export class Membrane {
  constructor ({ debugMode, primordials } = {}) {
    this.debugMode = debugMode
    // The primordial list is ~107 entries and used to be searched with
    // Array#includes on every bridge, which is a linear scan costing ~39ns per
    // miss - and a miss is the common case, since user objects are never
    // primordials. A Set makes it a hash lookup. Snapshotted at construction:
    // mutating `primordials` afterwards has no effect.
    if (primordials) {
      this.primordials = primordials
      this.primordialSet = new Set(primordials)
    } else {
      this.primordials = getPrimordialValues()
      this.primordialSet = getPrimordialSet()
    }
    // One record per raw reference, reachable from the raw reference and from
    // every proxy the membrane has made for it. It replaces the pair of
    // WeakMaps (proxy -> raw, raw -> origin) that every bridge used to consult
    // in sequence: at a few thousand live entries a WeakMap lookup costs about
    // 25ns, so collapsing two into one is worth more than it looks.
    this.refInfo = new WeakMap()
  }

  makeMembraneSpace (opts) {
    return new MembraneSpace(opts)
  }

  // if rawObj is not part of inGraph, should we explode?
  bridge (inRef, inGraph, outGraph) {
    //
    // skip if should be passed directly (danger)
    //

    // Non-objects are never wrapped. This is `shouldSkipBridge` inlined and
    // reordered: `typeof` rejects every primitive in a single test, where the
    // old `Array.isArray` gate cost 4ns on a primitive and 15ns on a proxy
    // (isArray pierces proxies down in the runtime).
    if (inRef === null) {
      return inRef
    }
    const type = typeof inRef
    if (type !== 'object' && type !== 'function') {
      return inRef
    }

    // if we've been asked to bridge a ref between the same to spaces, its a no-op
    if (inGraph === outGraph) {
      return inRef
    }

    //
    // unwrap ref and detect "origin" graph
    //

    let info = this.refInfo.get(inRef)

    if (info === undefined) {
      // Not a ref we know, so it is either a primordial or one we are seeing
      // for the first time. The primordial test lives here, after the identity
      // lookup, because a ref we have already recorded provably is not a
      // primordial - this keeps the hot path from paying for the check.
      if (this.primordialSet.has(inRef)) {
        return inRef
      }
      // we've never seen this ref before - must be raw and from inGraph
      //
      // Origin is written once, here, and never revised. It used to be
      // re-recorded on every bridge of a raw ref, so a ref that came back out
      // of a dangerouslyAlwaysUnwrap space - or that a caller bridged with the
      // wrong inGraph - was re-attributed to that space, and would then be
      // wrapped with that space's handler. An object that originated behind a
      // read-only distortion could re-enter a third space writable.
      // console.log(`assigning to "${inGraph.label}"`, this.debugLabelForValue(inRef))
      info = { raw: inRef, origin: inGraph }
      this.refInfo.set(inRef, info)
    }

    let rawRef = info.raw
    const originGraph = info.origin

    // allow graphs to pass through some values unwrapped
    if (outGraph.hasPassthroughFilter && outGraph.passthroughFilter(rawRef)) {
      return rawRef
    }

    //
    // wrap for ref for "out" graph
    //

    // if "out" graph is set to "alwaysUnwrap", deliver unwrapped
    if (outGraph.alwaysUnwrap) {
      // workaround for the arguments array which is an unwrapped array
      // with wrapped elements
      const isRawArgumentsArray = (inRef === rawRef && isArray(rawRef))
      if (isRawArgumentsArray) {
        // a fresh copy, never an in-place mutation of the caller's array
        const length = rawRef.length
        const unwrapped = new Array(length)
        for (let i = 0; i < length; i++) {
          unwrapped[i] = this.bridge(rawRef[i], inGraph, outGraph)
        }
        return unwrapped
      }
      return rawRef
    }

    // if this ref originates in the "out" graph, deliver unwrapped
    if (originGraph === outGraph) {
      return rawRef
    }

    // if outGraph already has bridged wrapping for rawRef, use it
    const cached = outGraph.rawToBridged.get(rawRef)
    if (cached !== undefined) {
      return cached
    }

    // create new wrapping for rawRef
    const distortionHandler = originGraph.getHandlerForRef(rawRef)
    const membraneProxyHandler = this.createMembraneProxyHandler(
      distortionHandler,
      rawRef,
      originGraph,
      outGraph,
    )
    const outRef = createFlexibleProxy(rawRef, membraneProxyHandler)
    // cache both ways: the out space can find the proxy from the raw ref, and
    // the proxy resolves to the same identity record as the raw ref does
    outGraph.rawToBridged.set(rawRef, outRef)
    this.refInfo.set(outRef, info)

    // all done
    return outRef
  }

  // handler stack

  // ProxyInvariantHandler calls next() <-- needs to have final say
  //   MembraneHandler calls next() <-- needs to see distortion result
  //     LocalWritesHandler sets behavior

  // both layers live in MembraneProxyHandler now, one instance per wrapped ref
  createMembraneProxyHandler (distortion, rawRef, originGraph, outGraph) {
    return new MembraneProxyHandler(this, distortion, rawRef, originGraph, outGraph)
  }

  // some values can/should not be membrane wrapped
  // (bridge() inlines this decision; this stays as the readable statement of it)
  shouldSkipBridge (value) {
    // check for null and non-objects, which covers undefined
    if (value === null) {
      return true
    }
    const valueType = typeof value
    if (valueType !== 'object' && valueType !== 'function') {
      return true
    }

    // primordials should not be wrapped
    if (this.primordialSet.has(value)) {
      return true
    }

    // otherwise needs to be wrapped
    return false
  }

  getOriginSpace (ref) {
    const info = this.refInfo.get(ref)
    return info === undefined ? undefined : info.origin
  }

  isWrapped (ref) {
    const info = this.refInfo.get(ref)
    // a raw ref is its own record's subject; anything else with a record is a
    // proxy this membrane made
    return info !== undefined && info.raw !== ref
  }

  // this returns a string representing the passed in value
  // it is used for debugging
  debugLabelForValue (inRef) {
    let rawRef, originLabel
    const info = this.refInfo.get(inRef)
    if (info !== undefined && info.raw !== inRef) {
      // we know this ref
      rawRef = info.raw
      originLabel = info.origin.label
    } else {
      // we dont know it
      rawRef = inRef
      originLabel = 'raw'
    }
    let valueLabel
    const type = typeof rawRef
    if (type === 'string') return `"${rawRef}"`
    if (type === 'object' && Array.isArray(rawRef)) {
      // && rawRef !== Array.prototype
      valueLabel = `[${rawRef.map(value => {
        if (Array.isArray(value)) return `<array>(${originLabel})`
        return this.debugLabelForValue(value)
      }).join(', ')}]`
      // return '<array>'
    } else if (type === 'function') {
      valueLabel= `<function: ${rawRef.name}>`
    } else {
      valueLabel = `<${type}>`
    }
    return `${valueLabel}(${originLabel})`
  }

}

//
// FlexibleProxy
//

function createFlexibleProxy (realTarget, membraneProxyHandler) {
  const flexibleTarget = getProxyTargetForValue(realTarget)
  const proxy = new Proxy(flexibleTarget, membraneProxyHandler)
  // let the traps recognise their own proxy arriving back as a receiver
  membraneProxyHandler.proxy = proxy
  return proxy
}

// use replacement proxyTarget for flexible distortions less restrained by "Proxy invariant"
// e.g. hide otherwise non-configurable properties
function getProxyTargetForValue (value) {
  if (typeof value === 'function') {
    if (value.prototype) {
      return function () {}
    } else {
      return () => {}
    }
  } else {
    if (isArray(value)) {
      return []
    } else {
      return {}
    }
  }
}

//
// MembraneProxyHandler
//
// One instance per wrapped reference, used directly as the Proxy handler.
//
// This replaces two layers that used to be built per wrapped object: a
// thirteen-property literal of closures (each capturing rawRef / originGraph /
// outGraph and each allocating its own `this.bridge.bind(this)`), and then two
// `Object.assign` copies of that literal to layer the proxy-invariant
// enforcement over it. That came to 30 function objects and 6 plain objects per
// wrap. Holding the per-object state in fields and the traps on the prototype
// costs one allocation, gives V8 a single hidden class for every membrane proxy
// handler in the process, and puts each invariant next to the trap it guards.
//
// The traps take fixed parameters. The old shape was
// `(_, ...outArgs) => outArgs.map(bridge)` followed by a spread call, which
// allocated a rest array, a map closure and a result array on every trap
// invocation - 33.5ns against 15.5ns for the direct form.
//
// Property keys are never bridged: they are always strings or symbols, and
// bridge() returns primitives unchanged, so the call was pure overhead.
//
// Traps whose result the specification immediately coerces with ToBoolean
// (has, set, deleteProperty, defineProperty, preventExtensions, isExtensible,
// setPrototypeOf) do not bridge their return value. The engine never hands that
// value to user code, so there is nothing to mediate.
class MembraneProxyHandler {
  constructor (membrane, distortion, rawRef, originGraph, outGraph) {
    this.membrane = membrane
    this.distortion = distortion
    this.rawRef = rawRef
    this.originGraph = originGraph
    this.outGraph = outGraph
    // assigned by createFlexibleProxy once the Proxy exists
    this.proxy = undefined
  }

  // origin graph -> out graph
  //
  // The primitive test is the same one bridge() applies first, repeated here so
  // that the common case - a trap result or argument that is a string, number,
  // boolean or undefined - does not pay for the call at all. bridge() keeps its
  // own copy, so no caller can regress by skipping this one.
  toOut (value) {
    if (value === null) return value
    const type = typeof value
    if (type !== 'object' && type !== 'function') return value
    return this.membrane.bridge(value, this.originGraph, this.outGraph)
  }

  // out graph -> origin graph
  toOrigin (value) {
    if (value === null) return value
    const type = typeof value
    if (type !== 'object' && type !== 'function') return value
    return this.membrane.bridge(value, this.outGraph, this.originGraph)
  }

  // A receiver that is our own proxy always unwraps to rawRef, so skip the two
  // WeakMap lookups bridge() would spend proving it.
  receiverToOrigin (receiver) {
    if (receiver === this.proxy) {
      return this.rawRef
    }
    return this.membrane.bridge(receiver, this.outGraph, this.originGraph)
  }

  // errors raised in the origin graph must not cross the boundary raw
  rethrow (err) {
    if (this.membrane.debugMode) {
      // in debugMode, we dont safely catch and wrap errors
      // while this is insecure, it makes debugging much easier
      throw err
    }
    throw this.membrane.bridge(err, this.originGraph, this.outGraph)
  }

  //
  // traps
  //

  getPrototypeOf (fakeTarget) {
    try {
      return this.toOut(this.distortion.getPrototypeOf(this.rawRef))
    } catch (err) { this.rethrow(err) }
  }

  setPrototypeOf (fakeTarget, proto) {
    try {
      return this.distortion.setPrototypeOf(this.rawRef, this.toOrigin(proto))
    } catch (err) { this.rethrow(err) }
  }

  isExtensible (fakeTarget) {
    try {
      return this.distortion.isExtensible(this.rawRef)
    } catch (err) { this.rethrow(err) }
  }

  preventExtensions (fakeTarget) {
    try {
      // check if provided handler allowed the preventExtensions call
      const didAllow = this.distortion.preventExtensions(this.rawRef)
      // if it did allow, we need to enforce this on the fakeTarget
      if (didAllow === true) {
        // transfer all keys onto fakeTarget
        const keys = this.copyOwnKeys()
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          const propDesc = this.descriptorToOut(this.distortion.getOwnPropertyDescriptor(this.rawRef, key))
          if (propDesc !== undefined) {
            Reflect.defineProperty(fakeTarget, key, propDesc)
          }
        }
        // transfer prototype
        Reflect.setPrototypeOf(fakeTarget, this.toOut(this.distortion.getPrototypeOf(this.rawRef)))
        // prevent extensions on fakeTarget
        Reflect.preventExtensions(fakeTarget)
      }
      // return the result
      return didAllow
    } catch (err) { this.rethrow(err) }
  }

  getOwnPropertyDescriptor (fakeTarget, key) {
    try {
      const propDesc = this.descriptorToOut(this.distortion.getOwnPropertyDescriptor(this.rawRef, key))
      // ensure propDesc matches proxy target's non-configurable property
      if (propDesc && !propDesc.configurable) {
        // if real target prop is non-configurable, update the fake target to ensure the invariant holds
        Reflect.defineProperty(fakeTarget, key, propDesc)
      }
      return propDesc
    } catch (err) { this.rethrow(err) }
  }

  defineProperty (fakeTarget, key, propDesc) {
    try {
      const didAllow = this.distortion.defineProperty(this.rawRef, key, this.descriptorToOrigin(propDesc))
      // need to also define on the fakeTarget
      if (didAllow && !propDesc.configurable) {
        Reflect.defineProperty(fakeTarget, key, propDesc)
      }
      return didAllow
    } catch (err) { this.rethrow(err) }
  }

  has (fakeTarget, key) {
    try {
      // `key in rawRef` looks like it should win here the way it does in get -
      // it measures 5.1ns against 11.2ns in isolation - but measured end to end
      // it costs about 10%. The keys reaching this trap vary, so the `in` site
      // goes polymorphic while Reflect.has stays a single builtin call.
      return this.distortion.has(this.rawRef, key)
    } catch (err) { this.rethrow(err) }
  }

  get (fakeTarget, key, receiver) {
    try {
      // When the receiver is our own proxy and the distortion does not
      // override get, Reflect.get(rawRef, key, rawRef) is by definition
      // rawRef[key] - the same [[Get]] with the same receiver - and measures
      // 5.1ns against 14.1ns.
      if (receiver === this.proxy && this.distortion.get === reflectGet) {
        return this.toOut(this.rawRef[key])
      }
      return this.toOut(this.distortion.get(this.rawRef, key, this.receiverToOrigin(receiver)))
    } catch (err) { this.rethrow(err) }
  }

  set (fakeTarget, key, value, receiver) {
    try {
      return this.distortion.set(this.rawRef, key, this.toOrigin(value), this.receiverToOrigin(receiver))
    } catch (err) { this.rethrow(err) }
  }

  deleteProperty (fakeTarget, key) {
    try {
      return this.distortion.deleteProperty(this.rawRef, key)
    } catch (err) { this.rethrow(err) }
  }

  ownKeys (fakeTarget) {
    try {
      return this.copyOwnKeys()
    } catch (err) { this.rethrow(err) }
  }

  apply (fakeTarget, thisArg, args) {
    try {
      return this.toOut(this.distortion.apply(this.rawRef, this.toOrigin(thisArg), this.argsToOrigin(args)))
    } catch (err) { this.rethrow(err) }
  }

  construct (fakeTarget, args, newTarget) {
    try {
      return this.toOut(this.distortion.construct(this.rawRef, this.argsToOrigin(args), this.receiverToOrigin(newTarget)))
    } catch (err) { this.rethrow(err) }
  }

  //
  // proxy protocol transport
  //
  // The key list, the property descriptors and the argument list are containers
  // the proxy protocol mints for itself. The engine converts each one back into
  // an internal record before anything can observe it, so a wrapped reference
  // could never escape through them - but wrapping them anyway is what made
  // ownKeys, getOwnPropertyDescriptor, apply and construct so expensive. Each
  // one used to become a full membrane proxy, freshly built on every single
  // call because these containers are never the same object twice, and the
  // engine then read every element back out through that proxy.
  //
  // Copying them instead is observationally identical: the same values, bridged
  // individually, arrive in the same places. Only the fields that can carry a
  // reference get bridged - and property keys never do, since they are always
  // strings or symbols.
  //

  copyOwnKeys () {
    const rawKeys = this.distortion.ownKeys(this.rawRef)
    const length = rawKeys.length
    const keys = new Array(length)
    for (let i = 0; i < length; i++) {
      keys[i] = rawKeys[i]
    }
    return keys
  }

  argsToOrigin (args) {
    const length = args.length
    const rawArgs = new Array(length)
    for (let i = 0; i < length; i++) {
      rawArgs[i] = this.toOrigin(args[i])
    }
    return rawArgs
  }

  // A descriptor leaving the origin graph is always handed straight to the
  // engine, which runs ToPropertyDescriptor and then CompletePropertyDescriptor
  // over it - so a missing field and a field present as undefined mean the same
  // thing, and the two canonical shapes can be emitted as whole object
  // literals. That gives every descriptor the membrane produces one hidden
  // class instead of a per-shape transition chain.
  descriptorToOut (rawDesc) {
    if (rawDesc === null || (typeof rawDesc !== 'object' && typeof rawDesc !== 'function')) {
      // undefined for an absent property, or something a distortion returned
      // that the engine is about to reject on our behalf
      return this.toOut(rawDesc)
    }
    const isAccessor = 'get' in rawDesc || 'set' in rawDesc
    if (!isAccessor) {
      if ('value' in rawDesc) {
        return {
          value: this.toOut(rawDesc.value),
          writable: this.toOut(rawDesc.writable),
          enumerable: this.toOut(rawDesc.enumerable),
          configurable: this.toOut(rawDesc.configurable)
        }
      }
    } else if (!('value' in rawDesc) && !('writable' in rawDesc)) {
      return {
        get: this.toOut(rawDesc.get),
        set: this.toOut(rawDesc.set),
        enumerable: this.toOut(rawDesc.enumerable),
        configurable: this.toOut(rawDesc.configurable)
      }
    }
    // Neither canonical shape - including the deliberately invalid mixtures a
    // distortion may produce, which the engine is responsible for rejecting.
    // Keep field presence exactly as it came.
    const propDesc = {}
    if ('value' in rawDesc) propDesc.value = this.toOut(rawDesc.value)
    if ('get' in rawDesc) propDesc.get = this.toOut(rawDesc.get)
    if ('set' in rawDesc) propDesc.set = this.toOut(rawDesc.set)
    if ('writable' in rawDesc) propDesc.writable = this.toOut(rawDesc.writable)
    if ('enumerable' in rawDesc) propDesc.enumerable = this.toOut(rawDesc.enumerable)
    if ('configurable' in rawDesc) propDesc.configurable = this.toOut(rawDesc.configurable)
    return propDesc
  }

  descriptorToOrigin (propDesc) {
    if (propDesc === null || (typeof propDesc !== 'object' && typeof propDesc !== 'function')) {
      return this.toOrigin(propDesc)
    }
    const rawDesc = {}
    if ('value' in propDesc) rawDesc.value = this.toOrigin(propDesc.value)
    if ('get' in propDesc) rawDesc.get = this.toOrigin(propDesc.get)
    if ('set' in propDesc) rawDesc.set = this.toOrigin(propDesc.set)
    if ('writable' in propDesc) rawDesc.writable = this.toOrigin(propDesc.writable)
    if ('enumerable' in propDesc) rawDesc.enumerable = this.toOrigin(propDesc.enumerable)
    if ('configurable' in propDesc) rawDesc.configurable = this.toOrigin(propDesc.configurable)
    return rawDesc
  }
}