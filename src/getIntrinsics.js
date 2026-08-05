import { getIntrinsics as collectIntrinsics } from './intrinsics.js'

export const getIntrinsics = () => {
  try {
    return collectIntrinsics()
  } catch (err) {
    const subErrMsg = err.stack || err.message || err
    throw new Error(`Cytoplasm failed to gather intrinsics. Please specify a "primordials" option to the Membrane constructor.\n${subErrMsg}`)
  }
}

// The intrinsics of a realm do not change, but gathering them was being redone
// by every Membrane, which is essentially the entire cost of constructing one.
// The snapshot is taken on first use rather than at module load so that an
// application still decides when it happens; under SES that wants to be after
// lockdown.
let cachedValues
let cachedSet

export const getPrimordialValues = () => {
  if (cachedValues === undefined) {
    cachedValues = Object.values(getIntrinsics())
  }
  // `membrane.primordials` is a public field, so hand out a copy rather than
  // letting one Membrane's consumer mutate every other Membrane's list
  return cachedValues.slice()
}

// Shared rather than copied: it is internal to the membrane and read-only on
// the hot path, and rebuilding a 107-entry Set per Membrane is not free.
export const getPrimordialSet = () => {
  if (cachedSet === undefined) {
    cachedSet = new Set(getPrimordialValues())
  }
  return cachedSet
}
