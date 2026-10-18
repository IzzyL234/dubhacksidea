const result = await Bun.build({entrypoints: ['src/ui-effects.js'], outdir: 'frontend', naming: 'effects.js', target: 'browser', minify: true});
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
console.log('Built the self-hosted Motion effects.');
