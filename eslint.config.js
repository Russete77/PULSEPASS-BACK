// Flat config (ESLint v9). Self-contido — não exige plugins externos.
// Corrige o achado da auditoria: o script "lint": "eslint src" referenciava
// um config inexistente.
export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Global do Node desde a 15. O despachante de webhook usa
        // AbortSignal.timeout para não ficar pendurado num endereço que
        // aceita a conexão e nunca responde.
        AbortSignal: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      // ignoreRestSiblings: `const { segredo, ...resto } = linha` é como se
      // OMITE campo interno antes de devolver ao cliente. Sem isto o padrão
      // vira aviso, e aviso que se aprende a ignorar deixa de ser aviso.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  { ignores: ['node_modules/**', 'dist/**'] },
];
