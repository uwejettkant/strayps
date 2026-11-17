import { defineConfig } from 'tsup';

export default defineConfig({
  // index: the library (`import ... from 'agent-leash'`); cli: the `agent-leash` binary
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['cjs'],
  target: 'node20',
  dts: { entry: 'src/index.ts' },
  clean: true,
  esbuildPlugins: [
    {
      // dist/cli.js loads dist/index.js at runtime instead of carrying a second copy of the library
      name: 'cli-uses-built-library',
      setup(build) {
        build.onResolve({ filter: /^\.\/index\.js$/ }, (args) =>
          args.importer.endsWith('cli.ts') ? { path: './index.js', external: true } : undefined,
        );
      },
    },
  ],
});
