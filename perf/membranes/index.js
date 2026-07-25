// Registry of the implementations under comparison.
//
// Entries are loaded lazily so that a missing optional peer (fast-membrane is
// installed straight from git and is not always reachable) degrades to a
// skipped row rather than failing the whole run.
//
// `caps` describes what an implementation can actually do, which lets suites
// declare their requirements and get skipped instead of silently measuring
// something else. Notably fast-membrane and observable-membrane hand back
// functions and classes *unwrapped*, so measuring `call`/`construct` against
// them would be measuring a bare function call.

const OBJECT_ONLY = {
  objects: true,
  deep: true,
  functions: false,
  classes: false,
  writable: true,
  keys: true
}

const EVERYTHING = {
  objects: true,
  deep: true,
  functions: true,
  classes: true,
  writable: true,
  keys: true
}

export const membranes = [
  {
    name: 'non-membrane:bare',
    group: 'baseline',
    load: () => import('./bare.js'),
    caps: EVERYTHING
  },
  {
    name: 'non-membrane:emptyProxy',
    group: 'baseline',
    load: () => import('./emptyProxy.js'),
    // shallow: children come back unwrapped
    caps: { ...EVERYTHING, deep: false }
  },
  {
    name: 'non-membrane:reflectProxy',
    group: 'baseline',
    load: () => import('./reflectProxy.js'),
    caps: { ...EVERYTHING, deep: false }
  },
  {
    name: 'non-membrane:recursiveProxy',
    group: 'baseline',
    load: () => import('./recursiveProxy.js'),
    caps: OBJECT_ONLY
  },
  {
    name: 'test:simpleMembrane',
    group: 'reference',
    load: () => import('./simpleMembrane.js'),
    caps: OBJECT_ONLY
  },
  {
    name: 'fast-membrane:symbol',
    group: 'reference',
    load: () => import('./fastSymbol.js'),
    caps: OBJECT_ONLY,
    optional: true
  },
  {
    name: 'fast-membrane:weakmap',
    group: 'reference',
    load: () => import('./fastWeakMap.js'),
    caps: OBJECT_ONLY,
    optional: true
  },
  {
    name: 'observable-membrane',
    group: 'reference',
    load: () => import('./observable.js'),
    caps: OBJECT_ONLY,
    optional: true
  },
  {
    name: 'cytoplasm:transparent',
    group: 'cytoplasm',
    load: () => import('./cytoplasmTransparent.js'),
    caps: EVERYTHING
  },
  {
    name: 'cytoplasm:readOnly',
    group: 'cytoplasm',
    load: () => import('./cytoplasmReadOnly.js'),
    // the read-only distortion rejects writes by design
    caps: { ...EVERYTHING, writable: false }
  }
]

export const membraneNames = membranes.map(m => m.name)

export function findMembrane (name) {
  const entry = membranes.find(m => m.name === name)
  if (!entry) throw new Error(`perf: unknown membrane "${name}"`)
  return entry
}

export async function loadMembraneFactory (name) {
  const entry = findMembrane(name)
  const module = await entry.load()
  return module.default
}
