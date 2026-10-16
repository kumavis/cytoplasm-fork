// Benchmark suites.
//
// A suite is:
//   name        stable identifier, also the key used in stored results
//   requires    capability flags the implementation must provide
//   size        number of fixtures built by `prepare`
//   opsPerRun   elementary membrane operations performed by one `run` call,
//               used to normalise results to nanoseconds-per-operation
//   prepare     (makeMembrane, size) => ctx, run once, never timed
//   state       (ctx) => state, defaults to the identity of ctx
//   freshState  when true, `state` runs before every timed iteration and its
//               cost is excluded from the measurement; this is how the
//               first-contact suites avoid measuring object construction
//   run         (state) => value, the timed body
//
// `prepare` receives the membrane *factory* rather than an instance so that a
// suite can build as many membranes as it needs.

import { createGenerator } from '../buildData.js'

const SIZE = 100

// each suite gets its own generator seed so adding or reordering suites does
// not perturb the fixtures the other suites see
const gen = (seed) => createGenerator(seed)

export const suites = [
  {
    name: 'get',
    description: 'read three own properties from each wrapped object',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE * 3,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(1).createFlatData(size).map(membrane.wrap)
    },
    run (data) {
      let sum = ''
      for (let i = 0; i < data.length; i++) {
        const entry = data[i]
        sum += entry.id
        sum += entry.label
        sum += entry.className
      }
      return sum
    }
  },

  {
    name: 'deep-get',
    description: 'walk a four-deep object chain through the membrane',
    requires: ['deep'],
    size: SIZE,
    opsPerRun: SIZE * 4,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(2).createDeepData(size).map(membrane.wrap)
    },
    run (data) {
      let sum = ''
      for (let i = 0; i < data.length; i++) {
        sum += data[i].a.b.c.label
      }
      return sum
    }
  },

  {
    name: 'set',
    description: 'assign three own properties on each wrapped object',
    requires: ['writable'],
    size: SIZE,
    opsPerRun: SIZE * 3,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return {
        objs: gen(3).createFlatData(size).map(membrane.wrap),
        phrases: gen(4).createPhrases(size)
      }
    },
    run (state) {
      const { objs, phrases } = state
      for (let i = 0; i < objs.length; i++) {
        const obj = objs[i]
        obj.id = i
        obj.label = phrases[i]
        obj.className = phrases[i]
      }
      return objs.length
    }
  },

  {
    name: 'set-reflect',
    description: 'Reflect.set through the membrane, works under rejecting distortions too',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE * 3,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return {
        objs: gen(3).createFlatData(size).map(membrane.wrap),
        phrases: gen(4).createPhrases(size)
      }
    },
    run (state) {
      const { objs, phrases } = state
      let accepted = 0
      for (let i = 0; i < objs.length; i++) {
        const obj = objs[i]
        if (Reflect.set(obj, 'id', i)) accepted++
        if (Reflect.set(obj, 'label', phrases[i])) accepted++
        if (Reflect.set(obj, 'className', phrases[i])) accepted++
      }
      return accepted
    }
  },

  {
    name: 'has',
    description: 'the `in` operator against wrapped objects, hits and misses',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE * 2,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(5).createFlatData(size).map(membrane.wrap)
    },
    run (data) {
      let count = 0
      for (let i = 0; i < data.length; i++) {
        if ('label' in data[i]) count++
        if ('nope' in data[i]) count++
      }
      return count
    }
  },

  {
    name: 'own-keys',
    description: 'Object.keys over wrapped objects',
    requires: ['keys'],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(6).createFlatData(size).map(membrane.wrap)
    },
    run (data) {
      let count = 0
      for (let i = 0; i < data.length; i++) {
        count += Object.keys(data[i]).length
      }
      return count
    }
  },

  {
    name: 'get-own-property-descriptor',
    description: 'Object.getOwnPropertyDescriptor through the membrane',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(7).createFlatData(size).map(membrane.wrap)
    },
    run (data) {
      let count = 0
      for (let i = 0; i < data.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(data[i], 'label')
        if (desc !== undefined) count++
      }
      return count
    }
  },

  {
    name: 'call',
    description: 'call a wrapped function with two arguments',
    requires: ['functions'],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      const fn = (a, b) => a + b
      return { fn: membrane.wrap(fn), size }
    },
    run (state) {
      const { fn, size } = state
      let sum = 0
      for (let i = 0; i < size; i++) {
        sum += fn(i, 1)
      }
      return sum
    }
  },

  {
    name: 'method-call',
    description: 'obj.method(a, b) on a wrapped object - the common real-world shape',
    requires: ['functions'],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      return gen(8).createMethodData(size).map(membrane.wrap)
    },
    run (data) {
      let sum = ''
      for (let i = 0; i < data.length; i++) {
        sum = data[i].combine('a', 'b')
      }
      return sum
    }
  },

  {
    name: 'construct',
    description: 'new WrappedClass(arg) through the membrane',
    requires: ['classes'],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      class Point {
        constructor (x, y) {
          this.x = x
          this.y = y
        }
      }
      return { Klass: membrane.wrap(Point), size }
    },
    run (state) {
      const { Klass, size } = state
      let last
      for (let i = 0; i < size; i++) {
        last = new Klass(i, i + 1)
      }
      return last
    }
  },

  {
    name: 'wrap-cold',
    description: 'first contact: bridge N never-before-seen objects',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE,
    freshState: true,
    maxBatch: 64,
    prepare (makeMembrane, size) {
      return { membrane: makeMembrane(), size }
    },
    state (ctx) {
      return { membrane: ctx.membrane, data: gen(9).createFlatData(ctx.size) }
    },
    run (state) {
      const { membrane, data } = state
      let last
      for (let i = 0; i < data.length; i++) {
        last = membrane.wrap(data[i])
      }
      return last
    }
  },

  {
    name: 'wrap-warm',
    description: 'repeat bridging of already-wrapped objects - the cache hit path',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      const data = gen(10).createFlatData(size)
      data.forEach(membrane.wrap)
      return { membrane, data }
    },
    run (state) {
      const { membrane, data } = state
      let last
      for (let i = 0; i < data.length; i++) {
        last = membrane.wrap(data[i])
      }
      return last
    }
  },

  {
    name: 'array-iter',
    description: 'index loop over a wrapped array of numbers',
    requires: [],
    size: SIZE,
    opsPerRun: SIZE + 1,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      const array = new Array(size)
      for (let i = 0; i < size; i++) array[i] = i
      return membrane.wrap(array)
    },
    run (array) {
      let sum = 0
      for (let i = 0; i < array.length; i++) {
        sum += array[i]
      }
      return sum
    }
  },

  {
    name: 'proto-get',
    description: 'inherited accessor and method across a wrapped prototype chain',
    requires: ['classes'],
    size: SIZE,
    opsPerRun: SIZE * 2,
    prepare (makeMembrane, size) {
      const membrane = makeMembrane()
      class Base {
        constructor (label) { this.label = label }
        get shout () { return this.label }
        describe () { return this.label }
      }
      const instances = new Array(size)
      const phrases = gen(11).createPhrases(size)
      for (let i = 0; i < size; i++) instances[i] = new Base(phrases[i])
      return instances.map(membrane.wrap)
    },
    run (data) {
      let sum = ''
      for (let i = 0; i < data.length; i++) {
        sum = data[i].shout
        sum = data[i].describe()
      }
      return sum
    }
  },

  {
    name: 'membrane-create',
    description: 'steady-state cost of standing up a membrane and two spaces',
    requires: [],
    size: 1,
    opsPerRun: 1,
    prepare (makeMembrane) {
      return makeMembrane
    },
    run (makeMembrane) {
      return makeMembrane()
    }
  }
]

export const suiteNames = suites.map(s => s.name)

export function findSuite (name) {
  const suite = suites.find(s => s.name === name)
  if (!suite) throw new Error(`perf: unknown suite "${name}"`)
  return suite
}

export function supports (membraneEntry, suite) {
  return suite.requires.every(cap => membraneEntry.caps[cap] === true)
}
