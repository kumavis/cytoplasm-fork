import { Membrane } from '../../src/index.js'
import createReadOnlyDistortion from '../../src/distortions/readOnly.js'

export default () => {
  const membrane = new Membrane()
  const cytoplasmSpaceA = membrane.makeMembraneSpace({ label: 'a', createHandler: createReadOnlyDistortion })
  const cytoplasmSpaceB = membrane.makeMembraneSpace({ label: 'b' })

  return {
    wrap: (obj) => membrane.bridge(obj, cytoplasmSpaceA, cytoplasmSpaceB)
  }
}
