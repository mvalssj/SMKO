// Run: node tools/test-fidelity.mjs
// Bundle the browser-dependent Race module for Node, replacing only the audio worklet URL import.
// No audio emulation or ROM graphics are exercised by these regression tests.
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['tools/fidelity-regression-test.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'test-worklet-url',
    setup(builder) {
      builder.onLoad({ filter: /worklet\.ts$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    },
  }],
});
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
