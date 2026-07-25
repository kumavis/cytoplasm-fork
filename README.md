# 🦠 cytoplasm 🔬

**warning: largely an educational exercise. has not been audited, here be dragons, etc**

(it used to say "too slow to be practical" here. property access through the membrane is now within a few percent of a bare `new Proxy(target, Reflect)`, which is the floor for anything built on proxies - see [performance](#performance). wrapping an object for the first time is still the expensive part.)

a javascript [membrane](https://tvcutsem.github.io/membranes) implementation.
This implementation is intended to provide *secure* isolation between any number of membrane spaces.
This implementation intends to support all types of objects including functions, classes, etc.
By default, all membrane spaces have a "transparent distortion", meaning all operations are forwarded to the original graph.
In order for this membrane to be useful you will need to provide a distortion implementation.

### features

##### intent of secure isolation
(note: this module has not been audited for security)
membrane-wrapped objects should always invoke the relevant distortion

##### multiple membrane spaces
the membrane will wrap/unwrap objects when passed across membrane space boundaries.
If an object is created in space A, passed to space B, then to space C, and returned to space A, it will be given to space A unwrapped as a raw object.

##### support for any object type
the membrane is intended to support any type of javascript object (TypedArray instances, objects with prototype chains, Proxy instances). empty values (`null`, `undefined`) and non-object values (number, string) are passed through un-wrapped. Primordials (`Object`, `Object.prototype`, etc) are also passed through unwrapped.

##### set distortions per-object
distortions are hooks into interactions with objects across MembraneSpace boundaries. The distortions are set at the object's origin MebraneSpace. The distortions are applied when the object is referenced in another MembraneSpace. The distortions are not applied in the origin MembraneSpace, as the object is a raw (unwrapped) reference there. The distortions will not be applied in MembraneSpaces that specify the option `{ dangerouslyAlwaysUnwrap: true }`.

distortions can be set in two ways:
- via the default handler for the MembraneSpace via the `createHandler` option.
- overridden for a specific reference via the `membraneSpace.handlerForRef` WeakMap.

Using these two approaches allows you to have a different distortion for a subset of the MembraneSpace's objects.

By default `createHandler` is called once per wrapped reference. If the handler it returns keeps no per-reference state — every trap is told which reference it is acting on, and `setHandlerForRef` takes the reference explicitly — set `createHandler.shareable = true` and the space will build one handler and reuse it for the whole space. The bundled `readOnly` and `alwaysThrow` distortions do this.

### origin space is write-once

The first MembraneSpace to present a raw reference to `bridge` becomes that reference's origin, permanently. A later `bridge` call naming a different in-graph — which is what happens when a `dangerouslyAlwaysUnwrap` space hands a raw reference back into the membrane — does not re-attribute it. Without this, an object that originated behind a read-only distortion could re-enter a third space with a plain `Reflect` handler and become writable.


### example

```js
import { Membrane } from 'cytoplasm'
import createReadOnlyDistortion from 'cytoplasm/src/distortions/readOnly.js'

const membrane = new Membrane()
const graphA = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
const graphB = membrane.makeMembraneSpace({ label: 'b' })

const objA = {
  value: 123,
  set: function (newVal) { this.value = newVal },
}
const objAWrappedForB = membrane.bridge(objA, graphA, graphB)

// original object is still mutable
objA.value = 456
// the specified readOnlyDistortion allows the wrapped object to internally mutate itself
// so the value is updated
objAWrappedForB.set(13)
// this assignment fails and throws an error under strict mode
objAWrappedForB.value = 42
```

### class instance origin space

The origin space of an instance of a class with cross-space protoype chain is somewhat complicated, due to differences in class constructors vs function constructors, as well as the Builtins.
The instance ends up being claimed by the first constructor it is exposed to. Since class constructors cant access `this` until they've called `super(...)`, ownership is pushed further down the chain. The function constructors can access `this` immediately and will claim the instance. Builtins skip membrane wrapping and so do not trigger a claim on `this`.

examples:

```
inst
class A
class B
class C <-- origin space
Object
```

```
inst
class A
function B <-- origin space
function C
Object
```


### comparison to other implementations

"n-sides" means it supports at least 3 spaces.
"security focused" means that user code can't unwrap the membrane (usually implies a WeakMap)

repo  | n-sides  | security focused | audit
---|---|---|---
cytoplasm  | ✓ | ✓ | x
[es-membrane][es-membrane]  | ✓ | ? | x
[@caridy/sjs][@caridy/sjs]  | x | ? | x
[observable-membrane][observable-membrane]  | x | ? | x
[fast-membrane][fast-membrane]  | x | x | x
[membrane-traits][membrane-traits]  | x | ? | x


[es-membrane]: https://github.com/ajvincent/es-membrane "es-membrane"
[@caridy/sjs]: https://github.com/caridy/secure-javascript-environment/ "secure-javascript-environment"
[observable-membrane]: https://github.com/salesforce/observable-membrane "observable-membrane"
[fast-membrane]: https://github.com/pmdartus/fast-membrane "fast-membrane"
[membrane-traits]: https://github.com/Gozala/membrane-traits "membrane-traits"

### performance

```sh
yarn performance          # full comparison, one process per case
yarn performance:quick    # cytoplasm rows plus controls
yarn performance:report   # timeseries across every recorded run
```

See [`perf/README.md`](./perf/README.md) for how the harness works and why it is
shaped the way it is. Every recorded run is kept in `perf/results/`.

Numbers below are **nanoseconds per elementary operation** (lower is better),
median of 3 trials, each case in its own process, node v22 on x64 linux.
I have noticed significant performance differences between node versions.

| implementation | get | deep-get | set | has | own-keys | gOPD | call | method-call | construct | wrap-cold | wrap-warm | array-iter | proto-get |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| non-membrane:bare | 6.5 | 2.7 | 0.7 | 0.5 | 13.7 | 25.6 | 0.9 | 15.9 | 7.6 | 4.4 | 0.8 | 0.8 | 0.5 |
| non-membrane:emptyProxy | 20.9 | - | 261.7 | 32.3 | 665.9 | 134.4 | 17.5 | 43.4 | 152.1 | 43.6 | 17.1 | 93.3 | 32.3 |
| non-membrane:reflectProxy | 41.4 | - | 808.6 | 33.5 | 2366.5 | 289.7 | 35.2 | 86.9 | 272.7 | 35.5 | 13.2 | 217.2 | 70.3 |
| non-membrane:recursiveProxy | 37.5 | 50.4 | 31.2 | 33.5 | 717.3 | 137.5 | - | - | - | 57.2 | 26.9 | 195.6 | - |
| test:simpleMembrane | 90.1 | 108.2 | 83.5 | 33.3 | 711.9 | 136.7 | - | - | - | 1183.7 | 21.0 | 256.7 | - |
| fast-membrane:symbol | 50.7 | 79.0 | 35.6 | 40.6 | 1534.6 | 324.7 | - | - | - | 68.4 | 21.6 | 210.8 | - |
| fast-membrane:weakmap | 46.6 | 71.6 | 35.3 | 40.0 | 1484.5 | 322.0 | - | - | - | 1303.0 | 43.4 | 209.8 | - |
| observable-membrane | 44.6 | 77.6 | 32.8 | 46.1 | 2186.3 | 328.2 | - | - | - | 1195.6 | 33.8 | 223.1 | - |
| **cytoplasm:transparent** | **38.3** | **69.1** | 83.0 | 40.1 | 2244.2 | 346.3 | **60.6** | **177.5** | **1981.5** | 1613.3 | **16.3** | **197.3** | **78.9** |
| **cytoplasm:readOnly** | **39.0** | **67.0** | n/a | 40.0 | 2086.3 | 313.0 | **59.7** | **179.5** | **2526.0** | 1785.8 | **15.6** | **202.5** | **78.9** |

A dash means the implementation cannot do that operation, so measuring it would
be measuring something else. `fast-membrane` and `observable-membrane` hand
functions and classes back **unwrapped**, which is why they have no
`call` / `method-call` / `construct` / `proto-get` numbers - cytoplasm is the
only entry in the table that mediates them at all. The read-only row has no
`set`, because rejecting the write is the point.

Two rows deserve a caveat rather than a victory lap. `set` is 83ns against
32-36ns for the object-only membranes, because they answer `true` without
performing the write through `Reflect.set` - which is also why none of them can
support a distortion that refuses a write. `own-keys` and `construct` are
dominated by work cytoplasm does and they do not: a descriptor lookup per key
with the proxy invariants enforced, and wrapping the freshly constructed
instance.

**Memory and startup**

| implementation | bytes retained per wrapped ref | import (ms) | first Membrane (ms) |
|---|---|---|---|
| non-membrane:reflectProxy | 32 | 0.61 | 0.03 |
| fast-membrane:symbol | 73 | 4.84 | 0.09 |
| test:simpleMembrane | 101 | 0.62 | 0.02 |
| observable-membrane | 201 | 3.25 | 0.07 |
| cytoplasm | 306 | 7.9 | 0.87 |

Cytoplasm's import cost is the vendored SES intrinsics machinery under `lib/`;
about 2ms of it is Node's ESM-to-CommonJS interop. The intrinsics walk is now
memoized, so the *second* and later `new Membrane()` in a process cost 0.01ms
rather than 0.87ms.

**What changed**

Against the pre-refactor implementation, same harness, same machine:

| suite | before | after | |
|---|---|---|---|
| get | 205.6 | 39.0 | 5.3x |
| deep-get | 273.3 | 67.0 | 4.1x |
| set (transparent) | 262.4 | 83.0 | 3.2x |
| has | 92.2 | 40.0 | 2.3x |
| own-keys | 25254.9 | 2086.3 | 12.1x |
| getOwnPropertyDescriptor | 6092.9 | 313.0 | 19.5x |
| call | 4263.7 | 59.7 | 71x |
| method-call | 4781.7 | 179.5 | 27x |
| construct | 7415.1 | 2526.0 | 2.9x |
| wrap-cold | 2850.1 | 1785.8 | 1.6x |
| wrap-warm | 75.3 | 15.6 | 4.8x |
| array-iter | 441.5 | 202.5 | 2.2x |
| proto-get | 2013.9 | 78.9 | 26x |
| membrane-create | 49960.3 | 221.8 | 225x |
| bytes per wrapped ref | 3010 | 306 | 9.8x |

Exact counts, per operation on an already-wrapped object:

| operation | proxies allocated | WeakMap operations |
|---|---|---|
| `obj.prop` | 0 -> 0 | 3 -> 0 |
| `obj.prop = v` | 0 -> 0 | 3 -> 0 |
| `Object.keys(obj)` | 6 -> 0 | 143 -> 4 |
| `Object.getOwnPropertyDescriptor(obj, k)` | 1 -> 0 | 22 -> 0 |
| `obj.method(a, b)` | 1 -> 0 | 26 -> 3 |

The step-by-step record, including the experiment that was measured and
reverted, is in `perf/results/` and renders with `yarn performance:report`.
