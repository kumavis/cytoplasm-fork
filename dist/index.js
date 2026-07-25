// src/getIntrinsics.js
import { getIntrinsics as getSesIntrinsics } from "../lib/intrinsics.cjs";
var getIntrinsics = () => {
  try {
    return getSesIntrinsics();
  } catch (err) {
    const subErrMsg = err.stack || err.message || err;
    throw new Error(`Cytoplasm failed to gather intrinsics. Please specify a "primordials" option to the Membrane constructor, apply core-js polyfills, or use node v12 or higher.
${subErrMsg}`);
  }
};

// src/index.js
var { isArray } = Array;
var MembraneSpace = class {
  constructor({ label, createHandler, dangerouslyAlwaysUnwrap, passthroughFilter }) {
    this.alwaysUnwrap = Boolean(dangerouslyAlwaysUnwrap);
    this.rawToBridged = /* @__PURE__ */ new WeakMap();
    this.handlerForRef = /* @__PURE__ */ new WeakMap();
    this.label = label;
    this.createHandler = createHandler || (() => Reflect);
    this.passthroughFilter = passthroughFilter || (() => false);
    this.hasPassthroughFilter = Boolean(passthroughFilter);
  }
  getHandlerForRef(rawRef) {
    const existing = this.handlerForRef.get(rawRef);
    if (existing !== void 0) {
      return existing;
    }
    const handler = this.createHandler({
      setHandlerForRef: (ref, newHandler) => this.handlerForRef.set(ref, newHandler)
    });
    this.handlerForRef.set(rawRef, handler);
    return handler;
  }
};
var Membrane = class {
  constructor({ debugMode, primordials } = {}) {
    this.debugMode = debugMode;
    this.primordials = primordials || Object.values(getIntrinsics());
    this.primordialSet = new Set(this.primordials);
    this.bridgedToRaw = /* @__PURE__ */ new WeakMap();
    this.rawToOrigin = /* @__PURE__ */ new WeakMap();
  }
  makeMembraneSpace(opts) {
    return new MembraneSpace(opts);
  }
  // if rawObj is not part of inGraph, should we explode?
  bridge(inRef, inGraph, outGraph) {
    if (inRef === null) {
      return inRef;
    }
    const type = typeof inRef;
    if (type !== "object" && type !== "function") {
      return inRef;
    }
    if (inGraph === outGraph) {
      return inRef;
    }
    let rawRef = this.bridgedToRaw.get(inRef);
    let originGraph;
    if (rawRef === void 0) {
      if (this.primordialSet.has(inRef)) {
        return inRef;
      }
      rawRef = inRef;
      originGraph = inGraph;
      this.rawToOrigin.set(inRef, inGraph);
    } else {
      originGraph = this.rawToOrigin.get(rawRef);
    }
    if (outGraph.hasPassthroughFilter && outGraph.passthroughFilter(rawRef)) {
      return rawRef;
    }
    if (outGraph.alwaysUnwrap) {
      const isRawArgumentsArray = inRef === rawRef && isArray(rawRef);
      if (isRawArgumentsArray) {
        rawRef = rawRef.map((childRef) => this.bridge(childRef, inGraph, outGraph));
      }
      return rawRef;
    }
    if (originGraph === outGraph) {
      return rawRef;
    }
    const cached = outGraph.rawToBridged.get(rawRef);
    if (cached !== void 0) {
      return cached;
    }
    const distortionHandler = originGraph.getHandlerForRef(rawRef);
    const membraneProxyHandler = this.createMembraneProxyHandler(
      distortionHandler,
      rawRef,
      originGraph,
      outGraph
    );
    const outRef = createFlexibleProxy(rawRef, membraneProxyHandler);
    outGraph.rawToBridged.set(rawRef, outRef);
    this.bridgedToRaw.set(outRef, rawRef);
    return outRef;
  }
  // handler stack
  // ProxyInvariantHandler calls next() <-- needs to have final say
  //   MembraneHandler calls next() <-- needs to see distortion result
  //     LocalWritesHandler sets behavior
  // both layers live in MembraneProxyHandler now, one instance per wrapped ref
  createMembraneProxyHandler(distortion, rawRef, originGraph, outGraph) {
    return new MembraneProxyHandler(this, distortion, rawRef, originGraph, outGraph);
  }
  // some values can/should not be membrane wrapped
  // (bridge() inlines this decision; this stays as the readable statement of it)
  shouldSkipBridge(value) {
    if (value === null) {
      return true;
    }
    const valueType = typeof value;
    if (valueType !== "object" && valueType !== "function") {
      return true;
    }
    if (this.primordialSet.has(value)) {
      return true;
    }
    return false;
  }
  getOriginSpace(ref) {
    const rawRef = this.bridgedToRaw.get(ref) || ref;
    const originSpace = this.rawToOrigin.get(rawRef);
    return originSpace;
  }
  isWrapped(ref) {
    return this.bridgedToRaw.has(ref);
  }
  // this returns a string representing the passed in value
  // it is used for debugging
  debugLabelForValue(inRef) {
    let rawRef, originLabel;
    if (this.bridgedToRaw.has(inRef)) {
      rawRef = this.bridgedToRaw.get(inRef);
      originLabel = this.rawToOrigin.get(rawRef).label;
    } else {
      rawRef = inRef;
      originLabel = "raw";
    }
    let valueLabel;
    const type = typeof rawRef;
    if (type === "string") return `"${rawRef}"`;
    if (type === "object" && Array.isArray(rawRef)) {
      valueLabel = `[${rawRef.map((value) => {
        if (Array.isArray(value)) return `<array>(${originLabel})`;
        return this.debugLabelForValue(value);
      }).join(", ")}]`;
    } else if (type === "function") {
      valueLabel = `<function: ${rawRef.name}>`;
    } else {
      valueLabel = `<${type}>`;
    }
    return `${valueLabel}(${originLabel})`;
  }
};
function createFlexibleProxy(realTarget, membraneProxyHandler) {
  const flexibleTarget = getProxyTargetForValue(realTarget);
  const proxy = new Proxy(flexibleTarget, membraneProxyHandler);
  membraneProxyHandler.proxy = proxy;
  return proxy;
}
function getProxyTargetForValue(value) {
  if (typeof value === "function") {
    if (value.prototype) {
      return function() {
      };
    } else {
      return () => {
      };
    }
  } else {
    if (isArray(value)) {
      return [];
    } else {
      return {};
    }
  }
}
var MembraneProxyHandler = class {
  constructor(membrane, distortion, rawRef, originGraph, outGraph) {
    this.membrane = membrane;
    this.distortion = distortion;
    this.rawRef = rawRef;
    this.originGraph = originGraph;
    this.outGraph = outGraph;
    this.proxy = void 0;
  }
  // origin graph -> out graph
  toOut(value) {
    return this.membrane.bridge(value, this.originGraph, this.outGraph);
  }
  // out graph -> origin graph
  toOrigin(value) {
    return this.membrane.bridge(value, this.outGraph, this.originGraph);
  }
  // A receiver that is our own proxy always unwraps to rawRef, so skip the two
  // WeakMap lookups bridge() would spend proving it.
  receiverToOrigin(receiver) {
    if (receiver === this.proxy) {
      return this.rawRef;
    }
    return this.membrane.bridge(receiver, this.outGraph, this.originGraph);
  }
  // errors raised in the origin graph must not cross the boundary raw
  rethrow(err) {
    if (this.membrane.debugMode) {
      throw err;
    }
    throw this.membrane.bridge(err, this.originGraph, this.outGraph);
  }
  //
  // traps
  //
  getPrototypeOf(fakeTarget) {
    try {
      return this.toOut(this.distortion.getPrototypeOf(this.rawRef));
    } catch (err) {
      this.rethrow(err);
    }
  }
  setPrototypeOf(fakeTarget, proto) {
    try {
      return this.distortion.setPrototypeOf(this.rawRef, this.toOrigin(proto));
    } catch (err) {
      this.rethrow(err);
    }
  }
  isExtensible(fakeTarget) {
    try {
      return this.distortion.isExtensible(this.rawRef);
    } catch (err) {
      this.rethrow(err);
    }
  }
  preventExtensions(fakeTarget) {
    try {
      const didAllow = this.distortion.preventExtensions(this.rawRef);
      if (didAllow === true) {
        const keys = this.copyOwnKeys();
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const propDesc = this.descriptorToOut(this.distortion.getOwnPropertyDescriptor(this.rawRef, key));
          if (propDesc !== void 0) {
            Reflect.defineProperty(fakeTarget, key, propDesc);
          }
        }
        Reflect.setPrototypeOf(fakeTarget, this.toOut(this.distortion.getPrototypeOf(this.rawRef)));
        Reflect.preventExtensions(fakeTarget);
      }
      return didAllow;
    } catch (err) {
      this.rethrow(err);
    }
  }
  getOwnPropertyDescriptor(fakeTarget, key) {
    try {
      const propDesc = this.descriptorToOut(this.distortion.getOwnPropertyDescriptor(this.rawRef, key));
      if (propDesc && !propDesc.configurable) {
        Reflect.defineProperty(fakeTarget, key, propDesc);
      }
      return propDesc;
    } catch (err) {
      this.rethrow(err);
    }
  }
  defineProperty(fakeTarget, key, propDesc) {
    try {
      const didAllow = this.distortion.defineProperty(this.rawRef, key, this.descriptorToOrigin(propDesc));
      if (didAllow && !propDesc.configurable) {
        Reflect.defineProperty(fakeTarget, key, propDesc);
      }
      return didAllow;
    } catch (err) {
      this.rethrow(err);
    }
  }
  has(fakeTarget, key) {
    try {
      return this.distortion.has(this.rawRef, key);
    } catch (err) {
      this.rethrow(err);
    }
  }
  get(fakeTarget, key, receiver) {
    try {
      return this.toOut(this.distortion.get(this.rawRef, key, this.receiverToOrigin(receiver)));
    } catch (err) {
      this.rethrow(err);
    }
  }
  set(fakeTarget, key, value, receiver) {
    try {
      return this.distortion.set(this.rawRef, key, this.toOrigin(value), this.receiverToOrigin(receiver));
    } catch (err) {
      this.rethrow(err);
    }
  }
  deleteProperty(fakeTarget, key) {
    try {
      return this.distortion.deleteProperty(this.rawRef, key);
    } catch (err) {
      this.rethrow(err);
    }
  }
  ownKeys(fakeTarget) {
    try {
      return this.copyOwnKeys();
    } catch (err) {
      this.rethrow(err);
    }
  }
  apply(fakeTarget, thisArg, args) {
    try {
      return this.toOut(this.distortion.apply(this.rawRef, this.toOrigin(thisArg), this.argsToOrigin(args)));
    } catch (err) {
      this.rethrow(err);
    }
  }
  construct(fakeTarget, args, newTarget) {
    try {
      return this.toOut(this.distortion.construct(this.rawRef, this.argsToOrigin(args), this.receiverToOrigin(newTarget)));
    } catch (err) {
      this.rethrow(err);
    }
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
  copyOwnKeys() {
    const rawKeys = this.distortion.ownKeys(this.rawRef);
    const length = rawKeys.length;
    const keys = new Array(length);
    for (let i = 0; i < length; i++) {
      keys[i] = rawKeys[i];
    }
    return keys;
  }
  argsToOrigin(args) {
    const length = args.length;
    const rawArgs = new Array(length);
    for (let i = 0; i < length; i++) {
      rawArgs[i] = this.toOrigin(args[i]);
    }
    return rawArgs;
  }
  descriptorToOut(rawDesc) {
    if (rawDesc === null || typeof rawDesc !== "object" && typeof rawDesc !== "function") {
      return this.toOut(rawDesc);
    }
    const propDesc = {};
    if ("value" in rawDesc) propDesc.value = this.toOut(rawDesc.value);
    if ("get" in rawDesc) propDesc.get = this.toOut(rawDesc.get);
    if ("set" in rawDesc) propDesc.set = this.toOut(rawDesc.set);
    if ("writable" in rawDesc) propDesc.writable = this.toOut(rawDesc.writable);
    if ("enumerable" in rawDesc) propDesc.enumerable = this.toOut(rawDesc.enumerable);
    if ("configurable" in rawDesc) propDesc.configurable = this.toOut(rawDesc.configurable);
    return propDesc;
  }
  descriptorToOrigin(propDesc) {
    if (propDesc === null || typeof propDesc !== "object" && typeof propDesc !== "function") {
      return this.toOrigin(propDesc);
    }
    const rawDesc = {};
    if ("value" in propDesc) rawDesc.value = this.toOrigin(propDesc.value);
    if ("get" in propDesc) rawDesc.get = this.toOrigin(propDesc.get);
    if ("set" in propDesc) rawDesc.set = this.toOrigin(propDesc.set);
    if ("writable" in propDesc) rawDesc.writable = this.toOrigin(propDesc.writable);
    if ("enumerable" in propDesc) rawDesc.enumerable = this.toOrigin(propDesc.enumerable);
    if ("configurable" in propDesc) rawDesc.configurable = this.toOrigin(propDesc.configurable);
    return rawDesc;
  }
};
export {
  Membrane,
  MembraneSpace
};
