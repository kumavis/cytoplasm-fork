// still allows functions that cause side effects
export default function createDistortion ({ setHandlerForRef }) {
  return {
    // prevent direct mutability
    setPrototypeOf: () => false,
    preventExtensions: () => false,
    defineProperty: () => false,
    set: (target, key, value, receiver) => {
      // Override mistake workaround
      if (target === receiver) {
        return false
      }

      // Indirect set, redirect to a defineProperty
      return Reflect.defineProperty(receiver, key, { value, enumerable: true, writable: true, configurable: true })
    },
    deleteProperty: () => false,
    // special case: instantiated children should be mutable
    construct: (...args) => {
      // construct child
      const result = Reflect.construct(...args)
      // set child as mutable
      setHandlerForRef(result, Reflect)
      // return constructed child
      return result
    },
    // default behavior
    apply: Reflect.apply,
    get: Reflect.get,
    getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    getPrototypeOf: Reflect.getPrototypeOf,
    has: Reflect.has,
    isExtensible: Reflect.isExtensible,
    ownKeys: Reflect.ownKeys
  }
}

// The handler above keeps no per-ref state - every trap is told which ref it is
// acting on, and setHandlerForRef takes the ref explicitly - so one handler can
// serve every ref in the space instead of one being built per wrapped ref.
createDistortion.shareable = true
