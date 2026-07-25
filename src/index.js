// theres some things we may need to enforce differently when in and out of strict mode
// e.g. fn.arguments
import { getIntrinsics } from './getIntrinsics.js'

const { isArray } = Array

export class MembraneSpace {
  constructor ({ label, createHandler, dangerouslyAlwaysUnwrap, passthroughFilter }) {
    this.alwaysUnwrap = Boolean(dangerouslyAlwaysUnwrap)
    this.rawToBridged = new WeakMap()
    this.handlerForRef = new WeakMap()
    this.label = label
    this.createHandler = createHandler || (() => Reflect)
    this.passthroughFilter = passthroughFilter || (() => false)
    // most spaces have no filter, and bridge() runs on every trap argument and
    // every trap result, so it is worth not calling a function to learn "no"
    this.hasPassthroughFilter = Boolean(passthroughFilter)
  }

  getHandlerForRef (rawRef) {
    const existing = this.handlerForRef.get(rawRef)
    if (existing !== undefined) {
      return existing
    }
    const handler = this.createHandler({
      setHandlerForRef: (ref, newHandler) => this.handlerForRef.set(ref, newHandler)
    })
    this.handlerForRef.set(rawRef, handler)
    return handler
  }
}

export class Membrane {
  constructor ({ debugMode, primordials } = {}) {
    this.debugMode = debugMode
    this.primordials = primordials || Object.values(getIntrinsics())
    // The primordial list is ~107 entries and used to be searched with
    // Array#includes on every bridge, which is a linear scan costing ~39ns per
    // miss - and a miss is the common case, since user objects are never
    // primordials. A Set makes it a hash lookup. Snapshotted at construction:
    // mutating `primordials` afterwards has no effect.
    this.primordialSet = new Set(this.primordials)
    this.bridgedToRaw = new WeakMap()
    this.rawToOrigin = new WeakMap()
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

    let rawRef = this.bridgedToRaw.get(inRef)
    let originGraph

    if (rawRef === undefined) {
      // Not one of our proxies, so it is either a primordial or a raw ref.
      // The primordial test lives here, after the identity lookup, because a
      // ref we have already bridged provably is not a primordial - this keeps
      // the hot path (re-bridging a known proxy) from paying for the check.
      if (this.primordialSet.has(inRef)) {
        return inRef
      }
      // we've never seen this ref before - must be raw and from inGraph
      rawRef = inRef
      originGraph = inGraph
      // record origin
      // console.log(`assigning to "${inGraph.label}"`, this.debugLabelForValue(rawRef))
      this.rawToOrigin.set(inRef, inGraph)
    } else {
      // we know this ref
      originGraph = this.rawToOrigin.get(rawRef)
    }

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
        rawRef = rawRef.map(childRef => this.bridge(childRef, inGraph, outGraph))
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
    // cache both ways
    outGraph.rawToBridged.set(rawRef, outRef)
    this.bridgedToRaw.set(outRef, rawRef)

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
    const rawRef = this.bridgedToRaw.get(ref) || ref
    const originSpace = this.rawToOrigin.get(rawRef)
    return originSpace
  }

  isWrapped (ref) {
    return this.bridgedToRaw.has(ref)
  }

  // this returns a string representing the passed in value
  // it is used for debugging
  debugLabelForValue (inRef) {
    let rawRef, originLabel
    if (this.bridgedToRaw.has(inRef)) {
      // we know this ref
      rawRef = this.bridgedToRaw.get(inRef)
      originLabel = this.rawToOrigin.get(rawRef).label
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
  toOut (value) {
    return this.membrane.bridge(value, this.originGraph, this.outGraph)
  }

  // out graph -> origin graph
  toOrigin (value) {
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
        const keys = this.bridgedOwnKeys()
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          const propDesc = this.bridgedOwnPropertyDescriptor(key)
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
      const propDesc = this.bridgedOwnPropertyDescriptor(key)
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
      const didAllow = this.distortion.defineProperty(this.rawRef, key, this.toOrigin(propDesc))
      // need to also define on the fakeTarget
      if (didAllow && !propDesc.configurable) {
        Reflect.defineProperty(fakeTarget, key, propDesc)
      }
      return didAllow
    } catch (err) { this.rethrow(err) }
  }

  has (fakeTarget, key) {
    try {
      return this.distortion.has(this.rawRef, key)
    } catch (err) { this.rethrow(err) }
  }

  get (fakeTarget, key, receiver) {
    try {
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
      return this.bridgedOwnKeys()
    } catch (err) { this.rethrow(err) }
  }

  apply (fakeTarget, thisArg, args) {
    try {
      return this.toOut(this.distortion.apply(this.rawRef, this.toOrigin(thisArg), this.toOrigin(args)))
    } catch (err) { this.rethrow(err) }
  }

  construct (fakeTarget, args, newTarget) {
    try {
      return this.toOut(this.distortion.construct(this.rawRef, this.toOrigin(args), this.receiverToOrigin(newTarget)))
    } catch (err) { this.rethrow(err) }
  }

  //
  // trap internals, called both by the traps and by the invariant enforcement
  // (which must not re-run the enforcement it is already inside of)
  //

  bridgedOwnKeys () {
    return this.toOut(this.distortion.ownKeys(this.rawRef))
  }

  bridgedOwnPropertyDescriptor (key) {
    return this.toOut(this.distortion.getOwnPropertyDescriptor(this.rawRef, key))
  }
}