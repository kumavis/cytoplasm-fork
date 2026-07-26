// The reachability suite.
//
// These tests exist to hold the membrane's isolation guarantee in place across
// refactors: from any value a space legitimately holds, no sequence of ordinary
// JavaScript reads may arrive at a raw reference owned by another space. They
// run against both builds, like the rest of the suite.

import * as helpers from './helpers.js'
import runIsolation from './isolation.js'
import runOrigin from './origin.js'
import runReceiver from './receiver.js'
import runContainers from './containers.js'
import runPrimordials from './primordials.js'
import runDistortions from './distortions.js'
import runLavatube from './lavatube.js'

const modules = [
  runIsolation,
  runOrigin,
  runReceiver,
  runContainers,
  runPrimordials,
  runDistortions,
  runLavatube
]

export default function runReachabilityTests (test, exports) {
  for (const runModule of modules) {
    runModule(test, exports, helpers)
  }
}
