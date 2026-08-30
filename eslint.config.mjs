export default [
  {
    ignores: ["coverage/**", "**/dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {},
  },
];
