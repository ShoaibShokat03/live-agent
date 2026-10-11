import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

const copyStatic = {
  name: 'copy-static',
  setup(b) {
    b.onEnd(() => {
      fs.mkdirSync('dist/renderer', { recursive: true });
      for (const f of ['index.html', 'styles.css']) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
    });
  },
};

const builds = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron', 'koffi'] },
  { ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife', plugins: [copyStatic] },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
