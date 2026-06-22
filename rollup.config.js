import esbuild from 'rollup-plugin-esbuild'

export default {
    input: 'src/app.ts',
    output: {
        file: 'dist/app.js',
        format: 'esm',
    },
    onwarn: (warning) => {
        if (warning.code === 'UNRESOLVED_IMPORT') return
    },
    plugins: [
        esbuild({
            target: 'es2022',
            loaders: {
                '.ts': 'ts',
            },
        }),
    ],
}
