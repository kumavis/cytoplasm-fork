# Changelog

## 4.0.0

Performance work across the membrane's hot paths, measured one change at a time,
plus a security fix and a narrower supported surface.

### Breaking

- **Node >= 22 is required.** Support stops at the oldest maintained LTS.
- **The CommonJS build is gone.** `main`, `module` and `exports.require` are
  removed along with `dist/`; the package ships its ESM source, which is what
  `exports.import` already resolved to. CommonJS consumers on the supported Node
  range are unaffected in practice — Node has had `require(esm)` since 22.12, so
  `require('cytoplasm')` still returns `{ Membrane, MembraneSpace }`.
- **`membrane.bridgedToRaw` and `membrane.rawToOrigin` no longer exist.** They
  collapsed into a single `refInfo` WeakMap of `{ raw, origin }` records.
  `isWrapped()` and `getOriginSpace()` are unchanged; code reaching into those
  two fields directly will break.
- **A reference's origin space is now write-once.** It used to be re-recorded on
  every bridge of a raw reference, so a reference handed out raw by a
  `dangerouslyAlwaysUnwrap` or `passthroughFilter` space was re-attributed to
  that space when passed onward, and re-wrapped with *its* handler — an object
  born behind a read-only distortion could re-enter a third space writable. This
  is a security fix. The trade-off is that a `bridge()` call naming the wrong
  in-graph now mis-attributes that reference permanently instead of correcting
  itself on the next call.

  Because that attribution is permanent, a trap may only guard the distortion
  call itself. Converting an out-graph value into the origin graph can throw —
  picking a proxy target reads `value.prototype`, which guest code can answer
  with a throw — and an error raised there is an *out-graph* value. Bridging it
  as though the origin graph had raised it records the origin space for a value
  the guest owns, and the guest can then have it handed back raw. So every trap
  converts its arguments before entering the `try`, and only the distortion
  invocation is caught. Covered by `test/reachability/origin.js`.
- **Distortion traps are invoked as methods of the distortion object**, so `this`
  inside a trap is the distortion rather than `undefined`.
- **Distortion traps are read per invocation** rather than captured when a
  reference is wrapped, so a distortion that swaps its own trap after the fact
  now takes effect.
- **`throw undefined` across the membrane throws** instead of being swallowed.
  The old code detected a throw with `if (originErr !== undefined)`, which could
  not tell a thrown `undefined` from a normal return.
- **Realm intrinsics are captured once, at first `Membrane` construction**, not
  per `Membrane`. A program that patches realm globals between two constructions
  now gets the earlier snapshot for both. The `primordials` constructor option
  still overrides completely.

### Added

- `createHandler.shareable = true` — a distortion factory whose handler keeps no
  per-reference state gets one handler per space instead of one per wrapped
  reference. The bundled `readOnly` and `alwaysThrow` distortions set it.
- Subpath exports for the bundled distortions. The import the README documents,
  `cytoplasm/src/distortions/readOnly.js`, previously failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` because the `exports` map declared only the
  root entry.
- A `LICENSE` file. MIT has been declared in `package.json` from the start, but
  the text was never committed.

### Removed

- **The vendored SES fork under `lib/`.** The realm intrinsics used to come from
  a Babel-compiled fork of SES's machinery, nine CommonJS files carried in the
  repository. It is replaced by a self-contained ESM collector in
  `src/intrinsics.js`, verified to produce exactly the same set — 107 names, 106
  distinct values, no difference in either direction — before the fork was
  deleted.

  The npm `ses` package cannot stand in for it: its only public surface is a
  shim that installs `lockdown`, `Compartment` and `assert` as globals, the
  intrinsics collector it uses internally is not reachable through its `exports`
  map, and deriving the list from a `Compartment`'s `globalThis` reaches 46 of
  the 106 values — missing `Object.prototype`, `Array.prototype` and
  `Function.prototype`, because those are prototypes rather than global
  properties.

### Performance

Nanoseconds per elementary operation, read-only distortion. Measured on a 4-core
Xeon at 2.80GHz, node v22, linux-x64 — **not portable across machines**. See
`perf/README.md` for the harness.

| suite | before | after | |
|---|---|---|---|
| get | 205.6 | 39.0 | 5.3x |
| deep-get | 273.3 | 67.0 | 4.1x |
| set (transparent) | 262.4 | 83.0 | 3.2x |
| has | 92.2 | 40.0 | 2.3x |
| own-keys | 25254.9 | 2086.3 | 12x |
| getOwnPropertyDescriptor | 6092.9 | 313.0 | 19x |
| call | 4263.7 | 59.7 | 71x |
| method-call | 4781.7 | 179.5 | 27x |
| construct | 7415.1 | 2526.0 | 2.9x |
| wrap-cold | 2850.1 | 1785.8 | 1.6x |
| wrap-warm | 75.3 | 15.6 | 4.8x |
| array-iter | 441.5 | 202.5 | 2.2x |
| proto-get | 2013.9 | 78.9 | 26x |
| membrane-create | 49960.3 | 221.8 | 225x |
| bytes retained per wrapped ref | 3010 | 306 | 9.8x |
| `import` cost (ms) | 7.9 | 2.7 | 2.9x |

The import figure is the vendored SES fork going away: removing those files
removes both Node's ESM-to-CommonJS interop for them and their own evaluation.

Exact allocation counts per operation on an already-wrapped object, which are
integers and so the regression tripwire that actually holds:

| operation | proxies allocated | WeakMap operations |
|---|---|---|
| `obj.prop` | 0 → 0 | 3 → 0 |
| `obj.prop = v` | 0 → 0 | 3 → 0 |
| `Object.keys(obj)` | 6 → 0 | 143 → 4 |
| `Object.getOwnPropertyDescriptor(obj, k)` | 1 → 0 | 22 → 0 |
| `obj.method(a, b)` | 1 → 0 | 26 → 3 |

### Known limitation

An object that is **already** non-extensible cannot be wrapped: the
`isExtensible` trap reports the raw object's extensibility while the proxy's
target is still extensible, and the engine rejects the mismatch with a
proxy-invariant `TypeError`. This predates 4.0.0 and is unchanged; calling
`preventExtensions` *through* the proxy is the supported route.
