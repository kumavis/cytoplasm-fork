/* eslint-disable no-extend-native */
// Patching WeakMap.prototype and Set.prototype is the point of this file: the
// counters have to sit under the implementation under test, and this module is
// only ever loaded by a throwaway benchmark process.

// Deterministic counters, for the paths where timing is useless.
//
// wrap-cold and construct are dominated by allocation, so their sample
// distributions are really a measurement of when the collector ran: a 20%
// median-absolute-deviation is normal there, which is wider than most of the
// wins worth chasing. Counting proxies, bridge calls and retained bytes gives
// integers instead - a regression in allocation shows up exactly, and it shows
// up before it turns into GC pressure in somebody's application.
//
// Install must happen before the implementation under test is imported, since
// it patches the globals the implementation closes over.

export function installCounters () {
  const counters = {
    proxy: 0,
    weakMapGet: 0,
    weakMapSet: 0,
    weakMapHas: 0,
    setHas: 0
  }

  const RealProxy = globalThis.Proxy
  class CountingProxy {
    constructor (target, handler) {
      counters.proxy++
      return new RealProxy(target, handler)
    }
  }
  CountingProxy.revocable = RealProxy.revocable
  globalThis.Proxy = CountingProxy

  const wm = WeakMap.prototype
  const realWeakMapGet = wm.get
  const realWeakMapSet = wm.set
  const realWeakMapHas = wm.has
  wm.get = function (key) { counters.weakMapGet++; return realWeakMapGet.call(this, key) }
  wm.set = function (key, value) { counters.weakMapSet++; return realWeakMapSet.call(this, key, value) }
  wm.has = function (key) { counters.weakMapHas++; return realWeakMapHas.call(this, key) }

  const realSetHas = Set.prototype.has
  Set.prototype.has = function (value) { counters.setHas++; return realSetHas.call(this, value) }

  return {
    counters,
    reset () {
      counters.proxy = 0
      counters.weakMapGet = 0
      counters.weakMapSet = 0
      counters.weakMapHas = 0
      counters.setHas = 0
    },
    snapshot () {
      return { ...counters }
    }
  }
}

// Wraps Membrane#bridge so bridge() invocations can be counted too. Takes the
// module namespace rather than a class so it also works against dist/.
export function countBridgeCalls (MembraneClass) {
  const state = { calls: 0 }
  const realBridge = MembraneClass.prototype.bridge
  MembraneClass.prototype.bridge = function (inRef, inGraph, outGraph) {
    state.calls++
    return realBridge.call(this, inRef, inGraph, outGraph)
  }
  return state
}
