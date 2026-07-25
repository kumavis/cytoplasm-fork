// Deterministic benchmark data.
//
// The generator is seeded so that two runs of the harness - possibly on
// different commits - see byte-identical inputs. Without this the shape and
// length of the generated strings vary run to run, which shows up as noise in
// the string-concatenation heavy suites.

const adjectives = [
  'pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome',
  'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful',
  'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive',
  'cheap', 'expensive', 'fancy'
]
const colors = [
  'red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown',
  'white', 'black', 'orange'
]
const nouns = [
  'table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie',
  'sandwich', 'burger', 'pizza', 'mouse', 'keyboard'
]

// mulberry32 - small, fast, good enough for generating benchmark fixtures
function makeRandom (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const DEFAULT_SEED = 0x5EED

export function createGenerator (seed = DEFAULT_SEED) {
  const random = makeRandom(seed)
  let nextId = 1

  const pick = (array) => array[Math.floor(random() * array.length)]
  const phrase = () => `${pick(adjectives)} ${pick(colors)} ${pick(nouns)}`

  const createObj = () => ({
    id: nextId++,
    label: phrase(),
    className: phrase()
  })

  const many = (count, fn) => {
    const out = new Array(count)
    for (let i = 0; i < count; i++) out[i] = fn(i)
    return out
  }

  const createDeepObj = () => {
    const obj = createObj()
    obj.a = createObj()
    obj.a.b = createObj()
    obj.a.b.c = createObj()
    return obj
  }

  // objects carrying methods, used by the call / method-call suites
  const createMethodObj = () => {
    const obj = createObj()
    obj.getLabel = function getLabel () { return this.label }
    obj.combine = function combine (a, b) { return `${this.label}${a}${b}` }
    return obj
  }

  return {
    random,
    phrase,
    createObj,
    createDeepObj,
    createMethodObj,
    createFlatData: (count) => many(count, createObj),
    createDeepData: (count) => many(count, createDeepObj),
    createMethodData: (count) => many(count, createMethodObj),
    createPhrases: (count) => many(count, phrase)
  }
}

// A shared default generator, so the simple call sites stay simple.
const defaultGenerator = createGenerator()

export const {
  createObj,
  createDeepObj,
  createMethodObj,
  createFlatData,
  createDeepData,
  createMethodData,
  createPhrases,
  phrase: randomPhrase
} = defaultGenerator

export function doManyTimes (count, fn) {
  const out = new Array(count)
  for (let i = 0; i < count; i++) out[i] = fn(i)
  return out
}
